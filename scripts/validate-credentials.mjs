import { execFileSync } from 'node:child_process';
if (process.platform === 'win32') {
  execFileSync('pwsh', ['-NoProfile', '-File', 'scripts/validate-credentials.ps1'], { stdio: 'inherit', windowsHide: true });
} else if (process.platform === 'linux') {
  execFileSync('pwsh', ['-NoProfile', '-File', 'scripts/validate-credentials.ps1'], { stdio: 'inherit' });
  execFileSync(process.execPath, ['--test', 'tests/linux-security.test.mjs'], { stdio: 'inherit' });
} else throw new Error('Supported hosts are Windows and Linux.');
