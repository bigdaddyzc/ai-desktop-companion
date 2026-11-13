import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: { main: 'src/desktop/main.ts', preload: 'src/desktop/preload.ts' },
  outdir: 'dist/desktop',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  // serialport 含原生模块（预编译 .node），不能打进 bundle，运行时从 node_modules 加载。
  external: ['electron', 'serialport'],
  sourcemap: true,
});
// 钩子脚本不进 bundle：安装时原样复制到用户目录，由 Claude Code / Codex / WorkBuddy 用 node 跑。
await copyFile(
  fileURLToPath(new URL('../src/desktop/hook/xinban-hook.cjs', import.meta.url)),
  fileURLToPath(new URL('../dist/desktop/xinban-hook.cjs', import.meta.url)),
);
