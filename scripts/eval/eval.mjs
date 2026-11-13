// 评测入口：把 scripts/eval/run.ts 打成一个 cjs，再用项目自带的 Electron 跑。
// 用法：npm run eval [-- 题号或分组,…]
// 环境变量：ROUNDS（每题几轮，默认 2）、CONCURRENCY（默认 4）、
//           XINBAN_EVAL_SOURCE（芯伴数据目录，默认 %APPDATA%\芯伴，只从里面拷密钥）。
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const outfile = join(root, 'dist', 'eval', 'run.cjs');
mkdirSync(join(root, 'dist', 'eval'), { recursive: true });
await build({
  entryPoints: [join(root, 'scripts', 'eval', 'run.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  outfile,
  logLevel: 'warning',
});

const electron = createRequire(import.meta.url)('electron');
const only = process.argv.slice(2).join(',');
// 临时 userData 在这里建、在 Electron 退出后删：里面有密钥副本，进程活着时删不干净。
const sandbox = mkdtempSync(join(tmpdir(), 'xinban-eval-'));
const cleanup = () => {
  try {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    console.error(`临时目录没删掉（里面有密钥副本），请手动删：${sandbox}`);
  }
};
const child = spawn(electron, [outfile], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    ...(only ? { ONLY: only } : {}),
    XINBAN_EVAL_SANDBOX: sandbox,
    ELECTRON_RUN_AS_NODE: undefined,
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill());
}
child.on('exit', (code) => {
  cleanup();
  process.exit(code ?? 1);
});
