import { createRequire } from 'node:module';
import path from 'node:path';
import { desktopEnvironment } from './desktop-settings.mjs';

try {
  const env = desktopEnvironment(process.env);
  for (const key of Object.keys(process.env)) if (key.startsWith('VMWARE_DESKTOP_')) delete process.env[key];
  Object.assign(process.env, env);
  // Load the exact shared bundle beside this launcher; never bundle a second
  // server or resolve it relative to the client's working directory.
  createRequire(path.resolve(process.argv[1]))('./server.cjs');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
