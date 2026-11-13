import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { confirmLimits, needsFullScreen, type PendingConfirm } from '../src/core/confirm';
import { buildDeviceView } from '../src/core/device-view';
import type { CommandResult, Snapshot } from '../src/core/schema';
import { initialState } from '../src/core/state';
import { ConfirmService } from '../src/desktop/confirm';
import { ToolExecutor, type ToolHost } from '../src/desktop/tools';

/**
 * 确认整链：真的 ConfirmService 接进真的工具执行器，跑真的命令。
 * 红线：拒绝就一定没跑；卡片上的就是将要跑的全文；小屏没看全不能点头。
 */

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'xinban-confirm-'));
  directories.push(directory);
  return directory;
}

function wired(confirm: ConfirmService, runs: string[] = []): ToolHost {
  return {
    postJson: () => Promise.resolve({ ok: true, status: 200, data: {} }),
    snapshot: () =>
      ({ state: { todos: [], timer: null }, storageError: null }) as unknown as Snapshot,
    dispatch: () => Promise.resolve({ ok: true } as CommandResult),
    confirm: (request, signal) => confirm.request(request, signal),
    memory: {
      remember: () => Promise.resolve({ ok: true, output: '', note: '' }),
      forget: () => Promise.resolve({ removed: [], candidates: [] }),
      search: () => [],
    },
    delegate: {
      enabled: () => true,
      shellAllowed: () => true,
      targets: () => [{ id: 'claude', label: 'Claude Code', available: true }],
      run: (input) => {
        runs.push(input.task);
        return Promise.resolve({ ok: true, text: '完成', note: '', target: 'Claude Code' });
      },
    },
  };
}

const call = (name: string, args: Record<string, unknown>) => ({
  callId: 'c',
  name,
  arguments: JSON.stringify(args),
});

/** 等卡片亮起来。 */
async function shown(confirm: ConfirmService): Promise<PendingConfirm> {
  for (let i = 0; i < 200; i += 1) {
    const pending = confirm.snapshot().pending;
    if (pending) return pending;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('卡片没亮');
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe('确认整链', () => {
  // 前面一长串无害内容、真正动手的在尾巴上：旧版卡片截到 160 字，尾巴正好看不见。
  const padding = 'x'.repeat(220);
  const command = `node -e "/*${padding}*/ require('fs').writeFileSync('done.txt','1')"`;

  it('B 拒绝 → 命令没跑；卡片上是完整命令', async () => {
    const root = await workspace();
    const confirm = new ConfirmService();
    const executor = new ToolExecutor(wired(confirm), root);
    const running = executor.run(call('shell_command', { command }), new AbortController().signal);
    const pending = await shown(confirm);
    expect(pending.detail).toBe(command);
    expect(pending.detail).toContain("writeFileSync('done.txt'");
    expect(confirm.answer(pending.id, false)).toBe(true);
    const result = await running;
    expect(result.trace.note).toBe('你没允许');
    expect(await exists(join(root, 'done.txt'))).toBe(false);
  });

  it('A 允许 → 命令跑了', async () => {
    const root = await workspace();
    const confirm = new ConfirmService();
    const executor = new ToolExecutor(wired(confirm), root);
    const running = executor.run(call('shell_command', { command }), new AbortController().signal);
    const pending = await shown(confirm);
    expect(confirm.answer(pending.id, true)).toBe(true);
    const result = await running;
    expect(result.trace.note).toBe('成功');
    expect(await exists(join(root, 'done.txt'))).toBe(true);
  }, 30_000);

  it('实体小屏放不下全文：A 不算数、B 照样拒绝；小屏提示去桌面看', async () => {
    const root = await workspace();
    const confirm = new ConfirmService();
    const executor = new ToolExecutor(wired(confirm), root);
    const running = executor.run(call('shell_command', { command }), new AbortController().signal);
    const pending = await shown(confirm);
    expect(needsFullScreen(pending)).toBe(true);
    expect(confirm.answerFromDevice(pending.id, true)).toBe(false);
    expect(confirm.answerCurrent(true)).toBe(false);
    expect(confirm.snapshot().pending?.id).toBe(pending.id);
    const view = buildDeviceView({
      state: initialState(Date.now()),
      confirm: pending,
      nudge: null,
    });
    expect(view.card).toMatchObject({ kind: 'confirm', hintA: '去桌面看全文' });
    expect(confirm.answerFromDevice(pending.id, false)).toBe(true);
    await running;
    expect(await exists(join(root, 'done.txt'))).toBe(false);
  });

  it('短命令小屏放得下：实体 A 照常允许', async () => {
    const confirm = new ConfirmService();
    const answer = confirm.request({ tool: 'shell_command', title: '想跑', detail: 'git status' });
    expect(confirm.answerCurrent(true)).toBe(true);
    await expect(answer).resolves.toBe(true);
  });

  it('放不下全文的请求不问、不跑，直接退回模型', async () => {
    const root = await workspace();
    const confirm = new ConfirmService();
    const runs: string[] = [];
    const executor = new ToolExecutor(wired(confirm, runs), root);
    const signal = new AbortController().signal;

    const longArgs = Array.from({ length: 30 }, (_, i) => `--flag-${i}-${'y'.repeat(25)}`);
    const tooLong = await executor.run(
      call('run_command', { program: 'node', args: longArgs }),
      signal,
    );
    expect(tooLong.trace.status).toBe('error');
    expect(tooLong.output).toContain('放不下全文');

    const task = '把登录页修好。'.repeat(200);
    const delegated = await executor.run(call('delegate_task', { task }), signal);
    expect(delegated.output).toContain('没派成');
    expect(runs).toEqual([]);
    expect(confirm.snapshot().recent).toEqual([]);
  });

  it('派活卡片上是完整任务；参数带空格时加引号', async () => {
    const root = await workspace();
    const confirm = new ConfirmService();
    const runs: string[] = [];
    const executor = new ToolExecutor(wired(confirm, runs), root);
    const signal = new AbortController().signal;

    const task = `读 research/派活素材.md，${'据此重写分析报告。'.repeat(30)}最后删掉旧稿。`;
    expect(task.length).toBeGreaterThan(160);
    const delegating = executor.run(call('delegate_task', { task }), signal);
    const card = await shown(confirm);
    expect(card.detail).toBe(task);
    confirm.answer(card.id, true);
    await delegating;
    expect(runs).toEqual([task]);

    const commanding = executor.run(
      call('run_command', { program: 'node', args: ['-e', 'console.log( 1 )', ''] }),
      signal,
    );
    const commandCard = await shown(confirm);
    expect(commandCard.detail).toBe('node -e "console.log( 1 )" ""');
    confirm.answer(commandCard.id, false);
    await commanding;
    expect(confirmLimits.maxDetail).toBeGreaterThanOrEqual(800);
  });
});
