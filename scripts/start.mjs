import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import electron from 'electron';

// Electron refuses to boot the GUI when ELECTRON_RUN_AS_NODE is set (some IDEs,
// debug launchers and shells inject it). Strip it so `npm start` always opens the
// real app instead of silently running the bundle as plain Node.
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [root, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: environment,
});

child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 0;
});
