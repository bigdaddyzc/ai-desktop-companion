import { chromium, expect, test, type Browser } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));

test('development entrypoint supports sandboxed interaction and React hot refresh', async ({}, info) => {
  test.setTimeout(90_000);
  const fixture = await mkdtemp(join(tmpdir(), 'xinban-dev-e2e-'));
  let child: ChildProcess | undefined;
  let browser: Browser | undefined;
  let output = '';
  const errors: string[] = [];
  try {
    // Edit only a disposable copy during HMR verification, never the working tree.
    for (const name of [
      'src',
      'scripts',
      'index.html',
      'vite.config.ts',
      'tsconfig.json',
      'package.json',
    ]) {
      await cp(join(root, name), join(fixture, name), { recursive: true });
    }
    await symlink(join(root, 'node_modules'), join(fixture, 'node_modules'), 'junction');
    await mkdir(join(fixture, 'user-data'));
    const env: NodeJS.ProcessEnv = { ...process.env, XINBAN_DATA_DIR: join(fixture, 'user-data') };
    delete env.NODE_OPTIONS;
    // This is the same script executed by npm run dev. CDP exists only in this test process.
    child = spawn(
      process.execPath,
      [
        join(fixture, 'scripts/dev.mjs'),
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
      ],
      {
        cwd: fixture,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout!.on('data', (data: Buffer) => {
      output += data.toString();
    });
    child.stderr!.on('data', (data: Buffer) => {
      output += data.toString();
    });
    const exit = new Promise<number | null>((done, reject) => {
      child!.once('error', reject);
      child!.once('exit', done);
    });
    await expect
      .poll(
        () => {
          if (child!.exitCode !== null) throw new Error(`Development startup failed: ${output}`);
          return output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1];
        },
        { timeout: 30_000 },
      )
      .toBeTruthy();
    const endpoint = output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)![1]!;
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0]!;
    const observe = (page: import('@playwright/test').Page) => {
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
    };
    context.pages().forEach(observe);
    context.on('page', observe);
    await expect.poll(() => context.pages().length).toBe(2);
    for (const page of context.pages()) await page.waitForURL(/window=(panel|companion)/);
    const panel = context.pages().find((page) => page.url().includes('window=panel'))!;
    const pet = context.pages().find((page) => page.url().includes('window=companion'))!;
    // 启动只显示桌面伙伴。CDP 连接下用鼠标点击不可靠，走与工具栏按钮相同的 IPC 打开面板。
    await pet.evaluate(() => window.companion!.windowAction('panel'));
    await expect(panel.getByRole('heading', { name: '认真做事，也好好休息。' })).toBeVisible();
    await panel.getByRole('button', { name: '设计', exact: true }).click();
    await expect(pet.locator('.screen-detail')).toHaveText('设计');
    await panel.getByLabel('会话名称').fill('HMR 保留的未提交草稿');
    const appFile = join(fixture, 'src/renderer/App.tsx');
    const original = await readFile(appFile, 'utf8');
    await writeFile(
      appFile,
      original.replace('认真做事，也好好休息。', '热更新完成，草稿还在。'),
      'utf8',
    );
    await expect(panel.getByRole('heading', { name: '热更新完成，草稿还在。' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(panel.getByLabel('会话名称')).toHaveValue('HMR 保留的未提交草稿');
    await expect(pet.locator('.screen-detail')).toHaveText('设计');
    await expect(pet.locator('html')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    expect(await panel.evaluate(() => typeof Reflect.get(window, 'require'))).toBe('undefined');
    await panel.screenshot({ path: info.outputPath('04-development-hmr.png'), fullPage: true });
    await panel.getByRole('button', { name: '退出芯伴' }).click();
    expect(await exit).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close().catch(() => undefined);
    if (child?.pid && child.exitCode === null) {
      // Terminate only the process tree created by this isolated test.
      if (process.platform === 'win32')
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else child.kill('SIGTERM');
    }
    await info.attach('development-output', { body: output, contentType: 'text/plain' });
    // Remove the junction itself before recursively deleting the fixture.
    await rm(join(fixture, 'node_modules'), { force: true, recursive: true });
    await rm(fixture, { force: true, recursive: true, maxRetries: 3, retryDelay: 200 });
  }
});
