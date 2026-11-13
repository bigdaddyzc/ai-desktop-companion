import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import electron from 'electron';
import './build-desktop.mjs';

// Avoid a trailing backslash in the quoted Electron argument on Windows.
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const server = await createServer({ root });
await server.listen();
server.printUrls();
const environment = { ...process.env, XINBAN_DEV: '1' };
delete environment.ELECTRON_RUN_AS_NODE;
// Forward only explicitly supplied CLI arguments; normal startup opens no debug port.
const child = spawn(electron, [...process.argv.slice(2), root], {
  stdio: 'inherit',
  env: environment,
});
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null) child.kill();
  await server.close();
  process.exit(code);
}
child.on('exit', (code) => {
  void stop(code ?? 0);
});
child.on('error', (error) => {
  console.error(error);
  void stop(1);
});
process.on('SIGINT', () => {
  void stop();
});
process.on('SIGTERM', () => {
  void stop();
});
