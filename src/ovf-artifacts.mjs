// Containment/manifest preflight only. OVF interpretation and conversion belong to OVF Tool.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import tar from 'tar-stream';
import { DOMParser } from '@xmldom/xmldom';
import { isWithin } from './workstation.mjs';

const OVF = 'http://schemas.dmtf.org/ovf/envelope/1';
export function xml(text) {
  if (Buffer.byteLength(text) > 4 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('XML is too large or contains a forbidden DTD/entity declaration.');
  return new DOMParser({ onError: () => { throw new Error('Malformed XML.'); } }).parseFromString(text, 'application/xml');
}
export function localName(value) {
  let name;
  try { name = decodeURIComponent(value); } catch { throw new Error('Invalid encoded appliance filename.'); }
  if (!name || name.length > 255 || name !== name.trim() || name === '.' || name === '..' || /[\\/:%\x00-\x1f<>"|?*]/.test(name) || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('Appliance references must be flat local filenames; URLs, traversal, devices and subdirectories are unsupported.');
  return name;
}
function references(descriptor) {
  const doc = xml(descriptor);
  if (doc.documentElement.namespaceURI !== OVF || doc.documentElement.localName !== 'Envelope') throw new Error('Expected an OVF Envelope descriptor.');
  const refs = [];
  for (const node of Array.from(doc.getElementsByTagName('*'))) {
    if (node.hasAttribute('xml:base') || node.hasAttributeNS('http://www.w3.org/XML/1998/namespace', 'base')) throw new Error('xml:base is unsupported for local appliance containment.');
    if (node.namespaceURI === OVF && node.localName === 'File') {
      if (node.hasAttributeNS(OVF, 'compression') || node.hasAttributeNS(OVF, 'chunkSize')) throw new Error('Compressed/chunked OVF references are not supported by this local preflight.');
      refs.push(localName(node.getAttributeNS(OVF, 'href')));
    }
  }
  if (refs.length > 4096 || new Set(refs.map(n => n.toLowerCase())).size !== refs.length) throw new Error('Too many or ambiguous OVF file references.');
  return refs;
}
const algorithms = ['sha1', 'sha256', 'sha512'];
async function digest(stream, capture = false) {
  const hashes = algorithms.map(name => createHash(name)); const chunks = []; const headers = []; let headerSize = 0; let size = 0;
  for await (const chunk of stream) {
    size += chunk.length; hashes.forEach(hash => hash.update(chunk));
    if (headerSize < 1024 * 1024) { const part = chunk.subarray(0, 1024 * 1024 - headerSize); headers.push(part); headerSize += part.length; }
    if (capture) { if (size > 4 * 1024 * 1024) throw new Error('Appliance descriptor/manifest exceeds 4 MiB.'); chunks.push(chunk); }
  }
  return { size, header: Buffer.concat(headers), hashes: Object.fromEntries(algorithms.map((name, i) => [name, hashes[i].digest('hex')])), text: capture ? Buffer.concat(chunks).toString('utf8') : undefined };
}
function checkDiskBackings(descriptor, files) {
  const doc = xml(descriptor); const fileIDs = new Map();
  for (const node of Array.from(doc.getElementsByTagNameNS(OVF, 'File'))) {
    const id = node.getAttributeNS(OVF, 'id');
    if (id && fileIDs.has(id)) throw new Error('Duplicate OVF file IDs are unsupported.');
    fileIDs.set(id, localName(node.getAttributeNS(OVF, 'href')));
  }
  for (const disk of Array.from(doc.getElementsByTagNameNS(OVF, 'Disk'))) {
    const ref = disk.getAttributeNS(OVF, 'fileRef');
    if (!ref) continue; // Empty disks are represented without a file backing.
    const header = files.get(fileIDs.get(ref))?.header;
    if (!header || header.length < 512 || header.subarray(0, 4).toString('ascii') !== 'KDMV') throw new Error('Appliance disks must be self-contained streamOptimized VMDKs; raw/linked disk descriptors are unsupported.');
    const offset = Number(header.readBigUInt64LE(28)) * 512; const size = Number(header.readBigUInt64LE(36)) * 512;
    if (!Number.isSafeInteger(offset + size) || !size || offset < 512 || offset + size > header.length) throw new Error('VMDK descriptor is outside the bounded preflight header.');
    const text = header.subarray(offset, offset + size).toString('latin1');
    if (!/createType\s*=\s*"streamOptimized"/i.test(text) || !/parentCID\s*=\s*ffffffff/i.test(text) || /parentFileNameHint\s*=/i.test(text)) throw new Error('Appliance disks must be independent streamOptimized VMDKs without parents.');
    for (const extent of text.matchAll(/(?:^|\n)(?:RW|RDONLY|NOACCESS)\s+\d+\s+(\w+)\s+"([^"]+)"/g)) {
      if (extent[1] !== 'SPARSE') throw new Error('External/raw disk extents are unsupported.');
      localName(extent[2]);
    }
  }
}
function checkManifest(text, files) {
  const seen = new Set();
  for (const line of text.split(/\r?\n/).filter(line => line.trim())) {
    const match = line.match(/^(SHA1|SHA256|SHA512)\s*\((.+)\)\s*=\s*([a-fA-F0-9]+)\s*$/);
    if (!match) throw new Error('Manifest has an unsupported algorithm or malformed entry.');
    const name = localName(match[2]); const algorithm = match[1].toLowerCase();
    if (seen.has(name)) throw new Error('Manifest has duplicate entries.'); seen.add(name);
    if (!files.has(name) || files.get(name).hashes[algorithm] !== match[3].toLowerCase()) throw new Error(`Manifest checksum mismatch or missing file: ${name}`);
  }
  const uncovered = [...files.keys()].filter(name => !/\.(mf|cert)$/i.test(name) && !seen.has(name));
  if (uncovered.length) throw new Error('Manifest does not cover every appliance file.');
}

export async function inspectArtifact(backend, input, { signal } = {}) {
  const source = await backend.hostPath(input, 'input-file');
  const ext = path.extname(source).toLowerCase();
  if (!['.ovf', '.ova'].includes(ext)) throw new Error('Source must be a local .ovf or .ova file.');
  signal?.throwIfAborted();
  const files = new Map(); let descriptorName; let headerBytes = 0;
  const add = (name, file) => { headerBytes += file.header.length; if (headerBytes > 64 * 1024 * 1024) throw new Error('Appliance exceeds the 64 MiB header preflight budget.'); files.set(name, file); };
  if (ext === '.ova') {
    const extract = tar.extract();
    const scan = pipeline(createReadStream(source), extract, { signal });
    // Handle pipeline rejection while the async iterator is draining entries.
    scan.catch(() => {});
    try {
      for await (const entry of extract) {
        signal?.throwIfAborted();
        const name = localName(entry.header.name);
        if (entry.header.type !== 'file' || files.size >= 4096 || [...files.keys()].some(key => key.toLowerCase() === name.toLowerCase())) throw new Error('OVA must contain unique flat regular files; links/directories are unsupported.');
        if (/\.ovf$/i.test(name)) { if (descriptorName) throw new Error('OVA must contain exactly one descriptor.'); descriptorName = name; }
        add(name, await digest(entry, /\.(ovf|mf)$/i.test(name)));
      }
      await scan;
    } catch (error) { extract.destroy(error); await scan.catch(() => {}); throw error; }
    if (!descriptorName) throw new Error('OVA has no OVF descriptor.');
  } else {
    descriptorName = path.basename(source);
    add(descriptorName, await digest(createReadStream(source, { signal }), true));
    const names = references(files.get(descriptorName).text);
    const manifest = `${path.basename(source, path.extname(source))}.mf`;
    for (const name of [...names, manifest]) {
      const filename = path.join(path.dirname(source), name);
      if (name === manifest) { try { await fs.lstat(filename); } catch (error) { if (error.code === 'ENOENT') continue; throw error; } }
      const resolved = await backend.hostPath(filename, 'input-file');
      if (!isWithin(path.dirname(source), resolved)) throw new Error('OVF reference escapes its source directory through a link.');
      if (!files.has(name)) add(name, await digest(createReadStream(resolved, { signal }), /\.mf$/i.test(name)));
    }
  }
  const refs = references(files.get(descriptorName).text);
  if (refs.some(name => !files.has(name))) throw new Error('Appliance references a missing file.');
  checkDiskBackings(files.get(descriptorName).text, files);
  const manifests = [...files].filter(([name]) => /\.mf$/i.test(name));
  if (manifests.length > 1) throw new Error('Multiple appliance manifests are unsupported.');
  if (manifests.length) checkManifest(manifests[0][1].text, files);
  return { source, descriptorName, manifest: manifests.length ? 'checksums verified (SHA1/SHA256/SHA512); signer trust is not established' : 'absent', descriptor: files.get(descriptorName).text, size: [...files.values()].reduce((size, file) => size + file.size, 0), files: [...files.keys()] };
}

// Machine mode uses TYPE lines and '+ ' prefixed payload lines, not JSON.
export function machineRecords(output) {
  const records = []; let current;
  for (const line of output.split(/\r?\n/)) {
    if (/^[A-Z_]+$/.test(line)) { current = { type: line, payload: '' }; records.push(current); }
    else if (line.startsWith('+') && current) current.payload += line.replace(/^\+ ?/, '') + '\n';
  }
  return records.map(record => ({ ...record, payload: record.payload.trim() }));
}
function elementValue(node) {
  const children = Array.from(node.childNodes || []).filter(child => child.nodeType === 1);
  if (!children.length) return node.textContent.trim();
  const result = {};
  for (const attr of Array.from(node.attributes || [])) result[`@${attr.name}`] = /^(value|defaultValue|password|secret|token)$/i.test(attr.localName) ? '[REDACTED]' : attr.value;
  for (const child of children) {
    const key = child.localName;
    // Appliance defaults can contain secrets. Do not return property default values.
    const value = /^(value|defaultValue|password|secret|token)$/i.test(key) ? '[REDACTED]' : elementValue(child);
    if (!Object.hasOwn(result, key)) result[key] = value;
    else if (Array.isArray(result[key])) result[key].push(value);
    else result[key] = [result[key], value];
  }
  return result;
}
export function probeMetadata(output) {
  const probe = machineRecords(output).find(record => record.type === 'PROBE');
  if (!probe) throw new Error('OVF Tool did not produce machine-readable PROBE metadata.');
  return elementValue(xml(probe.payload).documentElement);
}
