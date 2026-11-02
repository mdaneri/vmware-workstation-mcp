import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Linux exposes each 32-bit address word in native byte order in /proc/net/tcp*.
export function procAddress(hex, endian = os.endianness()) {
  if (!/^(?:[0-9A-F]{8}|[0-9A-F]{32})$/i.test(hex)) throw new Error('Unrecognized Linux TCP address.');
  const bytes = Buffer.from(hex, 'hex');
  if (endian === 'LE') for (let i = 0; i < bytes.length; i += 4) bytes.subarray(i, i + 4).reverse();
  if (bytes.length === 4) return [...bytes].join('.');
  if (bytes.every(byte => byte === 0)) return '::';
  if (bytes.subarray(0, 15).every(byte => byte === 0) && bytes[15] === 1) return '::1';
  return Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2).toString(16)).join(':');
}

export function parseProcListeners(text, port) {
  const result = [];
  for (const line of text.trim().split('\n').slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 10) throw new Error('Cannot parse Linux TCP listener metadata.');
    const [hex, portHex] = columns[1].split(':');
    if (columns[3] !== '0A' || Number.parseInt(portHex, 16) !== port) continue;
    if (!/^\d+$/.test(columns[9])) throw new Error('Cannot identify Linux listener socket inode.');
    result.push({ address: procAddress(hex), port, inode: columns[9] });
  }
  return result;
}

export async function inspectLinuxListener(port, { procRoot = '/proc' } = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid VNC listener port.');
  const tcp = await fs.readFile(path.join(procRoot, 'net/tcp'), 'utf8');
  const tcp6 = await fs.readFile(path.join(procRoot, 'net/tcp6'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''; // IPv6 may be disabled in the kernel.
    throw error;
  });
  const listeners = [...parseProcListeners(tcp, port), ...parseProcListeners(tcp6, port)];
  if (!listeners.length) return [];
  const owners = new Map();
  const inodes = new Set(listeners.map(item => item.inode));
  // Read only TCP/process metadata. No X11/Wayland or host input/capture APIs.
  for (const pid of (await fs.readdir(procRoot)).filter(name => /^\d+$/.test(name))) {
    const directory = path.join(procRoot, pid);
    let descriptors;
    try { descriptors = await fs.readdir(path.join(directory, 'fd')); } catch (error) {
      if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) continue;
      throw error;
    }
    const owned = new Set();
    for (const fd of descriptors) {
      const link = await fs.readlink(path.join(directory, 'fd', fd)).catch(error => {
        if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM', 'EINVAL'].includes(error.code)) return '';
        throw error;
      });
      const inode = link.match(/^socket:\[(\d+)\]$/)?.[1];
      if (inodes.has(inode)) owned.add(inode);
    }
    if (!owned.size) continue;
    let owner;
    try {
      const executable = await fs.readlink(path.join(directory, 'exe'));
      const args = (await fs.readFile(path.join(directory, 'cmdline'), 'utf8')).split('\0').filter(Boolean);
      owner = { pid: Number(pid), processName: path.basename(executable), arguments: args, commandLine: args.join(' ') };
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      continue; // Unverifiable owners remain explicitly unknown below.
    }
    for (const inode of owned) {
      const list = owners.get(inode) || [];
      list.push(owner); owners.set(inode, list);
    }
  }
  return listeners.flatMap(({ inode, ...listener }) => (owners.get(inode) || [{ processName: null, commandLine: null }]).map(owner => ({ ...listener, ...owner })));
}
