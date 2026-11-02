import path from 'node:path';

// The same user-only ACL policy used by the existing credentials setup script.
export function localFileProtector(backend) {
  const root = path.resolve(path.dirname(process.argv[1]), '..');
  return filename => backend.execute('pwsh', ['-NoProfile', '-File', path.join(root, 'scripts', 'Protect-LocalFile.ps1'), '-LiteralPath', filename], { windowsHide: true, shell: false, encoding: 'utf8', timeout: 10000 });
}
