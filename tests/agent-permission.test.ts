import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentPermissionTitle,
  canRemember,
  decisionFor,
  normalizeRemoteApprove,
  parseAgentPermission,
  type AgentPermissionRequest,
} from '../src/core/agent-permission';
import { parseHookEvents } from '../src/core/hook-events';
import { AgentPermissionBridge } from '../src/desktop/agent-permission';
import { ConfirmService } from '../src/desktop/confirm';

const scriptSource = fileURLToPath(new URL('../src/desktop/hook/xinban-hook.cjs', import.meta.url));

interface RemoteRequest {
  src: string;
  tool: string;
  input: unknown;
  cwd: string;
  fp: string;
  keys: string[];
  risk: string;
}
interface Hook {
  askRemote(
    dir: string,
    request: RemoteRequest,
    clock?: { now(): number; sleep(ms: number): void },
  ): string;
  fingerprint(tool: string, input: unknown): string;
  VERSION: number;
}
const hook = createRequire(import.meta.url)(scriptSource) as Hook;

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const FP = '0123456789abcdef';

function pendingFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: ID,
    fp: FP,
    src: 'claude-code',
    tool: 'Bash',
    cwd: 'D:/work/xinban',
    detail: 'npm test',
    keys: ['npm test'],
    risk: '',
    at: 1_000,
    deadline: 46_000,
    pid: 4242,
    ...overrides,
  };
}

describe('agent permission: domain', () => {
  it('parses a well-formed pending file and rejects tampered ones', () => {
    const ok = parseAgentPermission(pendingFile(), ID, 2_000);
    expect(ok?.detail).toBe('npm test');
    expect(ok?.source).toBe('claude-code');
    // 文件名和内容 id 对不上
    expect(parseAgentPermission(pendingFile(), 'other', 2_000)).toBeNull();
    // 已经过了截止时间
    expect(parseAgentPermission(pendingFile(), ID, 46_000)).toBeNull();
    // 截止时间比钩子能等的还长
    expect(parseAgentPermission(pendingFile({ deadline: 200_000 }), ID, 2_000)).toBeNull();
    // 详情超长：卡片放不下原文，不进芯伴
    expect(parseAgentPermission(pendingFile({ detail: 'x'.repeat(801) }), ID, 2_000)).toBeNull();
    expect(parseAgentPermission(pendingFile({ detail: '' }), ID, 2_000)).toBeNull();
    expect(parseAgentPermission(pendingFile({ src: 'codex' }), ID, 2_000)).toBeNull();
    expect(parseAgentPermission(pendingFile({ fp: 'zz' }), ID, 2_000)).toBeNull();
    expect(parseAgentPermission('garbage', ID, 2_000)).toBeNull();
  });

  it('titles, remember eligibility and decisions', () => {
    const request = parseAgentPermission(pendingFile(), ID, 2_000)!;
    expect(agentPermissionTitle(request)).toBe('Claude Code 想运行命令 · xinban');
    expect(agentPermissionTitle({ ...request, source: 'workbuddy', tool: 'Write', cwd: '' })).toBe(
      'WorkBuddy 想写文件',
    );
    expect(agentPermissionTitle({ ...request, risk: '删文件' })).toBe(
      'Claude Code 想运行命令 · xinban · ⚠删文件',
    );
    expect(canRemember(request)).toBe(true);
    expect(canRemember({ ...request, risk: '删文件' })).toBe(false);
    expect(canRemember({ ...request, keys: [] })).toBe(false);
    expect(decisionFor('allowed')).toBe('allow');
    expect(decisionFor('remembered')).toBe('allow');
    expect(decisionFor('denied')).toBe('deny');
    expect(decisionFor('deferred')).toBe('defer');
    expect(decisionFor('expired')).toBe('defer');
    expect(decisionFor('cancelled')).toBeNull();
  });

  it('config defaults to on / 45s and only accepts the listed waits', () => {
    expect(normalizeRemoteApprove(undefined)).toEqual({ enabled: true, waitMs: 45_000 });
    expect(normalizeRemoteApprove({ enabled: false, waitMs: 90_000 })).toEqual({
      enabled: false,
      waitMs: 90_000,
    });
    expect(normalizeRemoteApprove({ enabled: 'yes', waitMs: 31_000 })).toEqual({
      enabled: true,
      waitMs: 45_000,
    });
  });

  it('remote decisions move the session out of waiting only on allow/deny', () => {
    const line = (ev: string, at: number, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ v: 1, src: 'claude', ev, sid: 's1', cwd: 'D:/w', at, ...extra });
    const base = [line('UserPromptSubmit', 1), line('PermissionRequest', 2, { tool: 'Bash' })];
    const kind = (extra: string[]) => parseHookEvents([...base, ...extra].join('\n'))[0]?.kind;
    expect(kind([])).toBe('waiting');
    expect(kind([line('RemoteDecision', 3, { type: 'allow' })])).toBe('working');
    expect(kind([line('RemoteDecision', 3, { type: 'deny' })])).toBe('working');
    expect(kind([line('RemoteDecision', 3, { type: 'defer' })])).toBe('waiting');
    expect(kind([line('RemoteDecision', 3, { type: 'timeout' })])).toBe('waiting');
  });
});

describe('agent permission: hook wait loop', () => {
  let dir: string;
  const request: RemoteRequest = {
    src: 'claude-code',
    tool: 'Bash',
    input: { command: 'npm test' },
    cwd: 'D:/work/xinban',
    fp: FP,
    keys: ['npm test'],
    risk: '',
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xinban-remote-'));
    await writeFile(join(dir, 'alive'), String(Date.now()));
    await writeFile(
      join(dir, 'remote.json'),
      JSON.stringify({ v: 1, enabled: true, waitMs: 20_000 }),
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** 假时钟：每次 sleep 前进时间，并把此刻的 pending 交给 onTick（模拟芯伴主进程）。 */
  function clock(onTick: (pending: Record<string, unknown>[], tick: number) => void) {
    let now = Date.now();
    let tick = 0;
    return {
      now: () => now,
      sleep: (ms: number) => {
        tick += 1;
        now += ms;
        const pendingDir = join(dir, 'pending');
        const items = readdirSync(pendingDir)
          .filter((name) => name.endsWith('.json'))
          .map(
            (name) =>
              JSON.parse(readFileSync(join(pendingDir, name), 'utf8')) as Record<string, unknown>,
          );
        onTick(items, tick);
      },
    };
  }

  function decide(item: Record<string, unknown>, decision: string, fp = item['fp']) {
    mkdirSyncSafe(join(dir, 'decisions'));
    writeFileSync(
      join(dir, 'decisions', `${String(item['id'])}.json`),
      JSON.stringify({ v: 1, id: item['id'], fp, decision }),
    );
  }

  it.each(['allow', 'deny', 'defer'])('returns %s and cleans up both files', async (decision) => {
    const seen: Record<string, unknown>[] = [];
    const result = hook.askRemote(
      dir,
      request,
      clock((items) => {
        if (items[0]) {
          seen.push(items[0]);
          decide(items[0], decision);
        }
      }),
    );
    expect(result).toBe(decision);
    expect(seen[0]).toMatchObject({ v: 1, detail: 'npm test', fp: FP, src: 'claude-code' });
    expect(seen[0]!['deadline']).toBe((seen[0]!['at'] as number) + 20_000);
    expect(await readdir(join(dir, 'pending'))).toEqual([]);
    expect(await readdir(join(dir, 'decisions'))).toEqual([]);
  });

  it('times out to the terminal when nobody answers', () => {
    let ticks = 0;
    const result = hook.askRemote(
      dir,
      request,
      clock(() => {
        ticks += 1;
        // 模拟的芯伴一直在线
        writeFileSync(join(dir, 'alive'), String(Date.now()));
      }),
    );
    expect(result).toBe('timeout');
    expect(ticks).toBe(100); // 20 秒 / 200ms
  });

  it('gives up when 芯伴 goes offline mid-wait', () => {
    const result = hook.askRemote(
      dir,
      request,
      clock((_items, tick) => {
        if (tick === 3) writeFileSync(join(dir, 'alive'), '0');
      }),
    );
    expect(result).toBe('offline');
  });

  it('ignores decisions with a wrong fingerprint or half-written content', () => {
    const result = hook.askRemote(
      dir,
      request,
      clock((items, tick) => {
        const item = items[0]!;
        if (tick === 1) decide(item, 'allow', 'ffffffffffffffff');
        if (tick === 2)
          writeFileSync(join(dir, 'decisions', `${String(item['id'])}.json`), '{"v":1,"id":');
        if (tick === 3) decide(item, 'deny');
      }),
    );
    expect(result).toBe('deny');
  });

  it("two concurrent requests never read each other's decision", () => {
    // 先放一个别人的 pending + 它的「允许」；我们这条应该只认自己的拒绝。
    const other = { id: ID, fp: FP };
    mkdirSyncSafe(join(dir, 'pending'));
    writeFileSync(join(dir, 'pending', `${ID}.json`), JSON.stringify(pendingFile()));
    decide(other, 'allow');
    const result = hook.askRemote(
      dir,
      request,
      clock((items) => {
        const mine = items.find((item) => item['id'] !== ID);
        if (mine) decide(mine, 'deny');
      }),
    );
    expect(result).toBe('deny');
    // 别人的文件原样留着
    expect(readdirSync(join(dir, 'decisions'))).toEqual([`${ID}.json`]);
  });

  it('does not ask when switched off, 芯伴 is closed, or the detail is too long', async () => {
    const never = clock(() => {
      throw new Error('should not wait');
    });
    await writeFile(
      join(dir, 'remote.json'),
      JSON.stringify({ v: 1, enabled: false, waitMs: 20_000 }),
    );
    expect(hook.askRemote(dir, request, never)).toBe('off');
    await writeFile(
      join(dir, 'remote.json'),
      JSON.stringify({ v: 1, enabled: true, waitMs: 20_000 }),
    );
    await writeFile(join(dir, 'alive'), '0');
    expect(hook.askRemote(dir, request, never)).toBe('off');
    await writeFile(join(dir, 'alive'), String(Date.now()));
    const long = { ...request, input: { command: `echo ${'x'.repeat(900)}` } };
    expect(hook.askRemote(dir, long, never)).toBe('off');
    await rm(join(dir, 'remote.json'));
    expect(hook.askRemote(dir, request, never)).toBe('off');
  });

  it('is version 5', () => {
    expect(hook.VERSION).toBe(5);
  });
});

function mkdirSyncSafe(path: string): void {
  mkdirSync(path, { recursive: true });
}

describe('agent permission: ConfirmService external queue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const card = (canRemember = true) => ({
    tool: 'agent_permission' as const,
    title: 'Claude Code 想运行命令',
    detail: 'npm test',
    external: { canRemember },
  });

  it('expires to deferred at the hook deadline, even while queued', async () => {
    vi.useFakeTimers();
    const confirm = new ConfirmService(() => Date.now(), 60_000);
    const own = confirm.request({ tool: 'run_command', title: '跑命令', detail: 'ls' });
    const ext = confirm.requestExternal(card(), Date.now() + 20_000);
    expect(confirm.snapshot().pending?.tool).toBe('run_command');
    vi.advanceTimersByTime(20_000);
    await expect(ext.outcome).resolves.toBe('deferred');
    // 芯伴自己的那条不受影响，仍在等
    expect(confirm.snapshot().pending?.tool).toBe('run_command');
    vi.advanceTimersByTime(40_000);
    await expect(own).resolves.toBe(false);
  });

  it('remember only works on cards that offer it; defer and dismiss settle', async () => {
    const confirm = new ConfirmService();
    const risky = confirm.requestExternal(card(false), Date.now() + 20_000);
    expect(confirm.answerExternal(risky.id, 'remember')).toBe(false);
    expect(confirm.answerExternal(risky.id, 'defer')).toBe(true);
    await expect(risky.outcome).resolves.toBe('deferred');

    const safe = confirm.requestExternal(card(true), Date.now() + 20_000);
    expect(confirm.snapshot().pending?.external).toEqual({ canRemember: true });
    expect(confirm.answerExternal(safe.id, 'remember')).toBe(true);
    await expect(safe.outcome).resolves.toBe('remembered');

    const gone = confirm.requestExternal(card(), Date.now() + 20_000);
    expect(confirm.dismiss(gone.id)).toBe(true);
    await expect(gone.outcome).resolves.toBe('cancelled');

    // 自己的工具卡没有这两个按钮
    void confirm.request({ tool: 'run_command', title: '跑', detail: 'ls' });
    const ownId = confirm.snapshot().pending!.id;
    expect(confirm.answerExternal(ownId, 'defer')).toBe(false);
    confirm.cancelAll();
  });

  it('external queue has its own limit and does not crowd out own tools', async () => {
    const confirm = new ConfirmService();
    const ext = Array.from({ length: 5 }, () =>
      confirm.requestExternal(card(), Date.now() + 20_000),
    );
    await expect(ext[4]!.outcome).resolves.toBe('deferred');
    const own = confirm.request({ tool: 'run_command', title: '跑', detail: 'ls' });
    expect(confirm.snapshot().queued).toBe(4);
    confirm.deferAllExternal();
    for (const item of ext.slice(0, 4)) await expect(item.outcome).resolves.toBe('deferred');
    expect(confirm.snapshot().pending?.tool).toBe('run_command');
    expect(confirm.answerCurrent(true)).toBe(true);
    await expect(own).resolves.toBe(true);
  });

  it('device A cannot approve a long external command, only deny', async () => {
    const confirm = new ConfirmService();
    const long = confirm.requestExternal(
      { ...card(), detail: 'npm run build -- --mode production' },
      Date.now() + 20_000,
    );
    expect(confirm.answerCurrent(true)).toBe(false);
    expect(confirm.answerCurrent(false)).toBe(true);
    await expect(long.outcome).resolves.toBe('denied');
  });
});

describe('agent permission: desktop bridge', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xinban-bridge-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function putPending(overrides: Record<string, unknown> = {}) {
    await mkdir(join(dir, 'pending'), { recursive: true });
    const now = Date.now();
    await writeFile(
      join(dir, 'pending', `${ID}.json`),
      JSON.stringify(pendingFile({ at: now, deadline: now + 20_000, ...overrides })),
    );
  }

  async function decision(): Promise<Record<string, unknown> | null> {
    for (let i = 0; i < 50; i += 1) {
      try {
        return JSON.parse(await readFile(join(dir, 'decisions', `${ID}.json`), 'utf8')) as Record<
          string,
          unknown
        >;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return null;
  }

  function bridge(confirm: ConfirmService, alive = () => true) {
    const remembered: AgentPermissionRequest[] = [];
    const logs: Record<string, unknown>[] = [];
    const instance = new AgentPermissionBridge(
      dir,
      confirm,
      {
        remember: async (request) => {
          remembered.push(request);
        },
        log: (_event, fields) => logs.push(fields),
      },
      Date.now,
      alive,
    );
    return { instance, remembered, logs };
  }

  it('writes remote.json with defaults on first load', async () => {
    const { instance } = bridge(new ConfirmService());
    await instance.load();
    expect(JSON.parse(await readFile(join(dir, 'remote.json'), 'utf8'))).toEqual({
      v: 1,
      enabled: true,
      waitMs: 45_000,
    });
  });

  it('shows the card, writes allow with id+fp, and remembers on request', async () => {
    const confirm = new ConfirmService();
    const { instance, remembered, logs } = bridge(confirm);
    await instance.load();
    await putPending();
    await instance.scan();
    const pending = confirm.snapshot().pending!;
    expect(pending.title).toBe('Claude Code 想运行命令 · xinban');
    expect(pending.detail).toBe('npm test');
    confirm.answerExternal(pending.id, 'remember');
    expect(await decision()).toEqual({ v: 1, id: ID, fp: FP, decision: 'allow' });
    expect(remembered[0]?.keys).toEqual(['npm test']);
    // 日志里没有命令原文
    expect(JSON.stringify(logs)).not.toContain('npm test');
    expect(logs[0]).toMatchObject({ source: 'claude-code', tool: 'Bash', outcome: 'remembered' });
  });

  it('withdraws the card when the hook process dies or the file disappears', async () => {
    const confirm = new ConfirmService();
    let alive = true;
    const { instance } = bridge(confirm, () => alive);
    await instance.load();
    await putPending();
    await instance.scan();
    expect(confirm.snapshot().pending).not.toBeNull();
    alive = false;
    await instance.scan();
    expect(confirm.snapshot().pending).toBeNull();
    expect(await readdir(join(dir, 'decisions')).catch(() => [])).toEqual([]);
  });

  it('turning it off hands everything back to the terminal', async () => {
    const confirm = new ConfirmService();
    const { instance } = bridge(confirm);
    await instance.load();
    await putPending();
    await instance.scan();
    await instance.save({ enabled: false, waitMs: 45_000 });
    expect(await decision()).toMatchObject({ decision: 'defer' });
    expect(confirm.snapshot().pending).toBeNull();
  });

  it('ignores malformed pending files', async () => {
    const confirm = new ConfirmService();
    const { instance } = bridge(confirm);
    await instance.load();
    await putPending({ detail: 'x'.repeat(900) });
    await instance.scan();
    expect(confirm.snapshot().pending).toBeNull();
  });
});

describe('agent permission: end to end with the real hook process', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xinban-remote-e2e-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function setup() {
    const hooks = join(dir, 'hooks');
    await mkdir(hooks, { recursive: true });
    const script = join(hooks, 'xinban-hook.cjs');
    await writeFile(script, await readFile(scriptSource, 'utf8'));
    await writeFile(join(hooks, 'alive'), String(Date.now()));
    const confirm = new ConfirmService();
    const bridge = new AgentPermissionBridge(hooks, confirm, {
      remember: async () => undefined,
      log: () => undefined,
    });
    await bridge.load();
    await bridge.save({ enabled: true, waitMs: 20_000 });
    bridge.start();
    const inbox = join(dir, 'events.ndjson');
    const run = (input: unknown) =>
      new Promise<{ stdout: string; ms: number }>((resolve) => {
        const started = Date.now();
        const child = spawn(process.execPath, [script, 'claude', inbox]);
        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
        child.on('close', () => resolve({ stdout, ms: Date.now() - started }));
        child.stdin.end(JSON.stringify(input));
      });
    return { hooks, script, confirm, bridge, inbox, run };
  }

  const ask = {
    session_id: 's1',
    hook_event_name: 'PermissionRequest',
    cwd: 'D:/work/xinban',
    tool_name: 'Bash',
    tool_input: { command: 'npm run lint -- --fix src/private-name.ts' },
  };

  async function waitForCard(confirm: ConfirmService) {
    for (let i = 0; i < 200; i += 1) {
      const pending = confirm.snapshot().pending;
      if (pending) return pending;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('no card');
  }

  it('allow on 芯伴 → hook prints allow; defer → prints nothing', async () => {
    const { confirm, bridge, inbox, run } = await setup();
    try {
      const first = run(ask);
      const card = await waitForCard(confirm);
      expect(card.detail).toBe('npm run lint -- --fix src/private-name.ts');
      confirm.answer(card.id, true);
      const allowed = await first;
      expect(JSON.parse(allowed.stdout)).toEqual({
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
      });

      const second = run(ask);
      const card2 = await waitForCard(confirm);
      confirm.answerExternal(card2.id, 'defer');
      expect((await second).stdout).toBe('');

      const third = run(ask);
      const card3 = await waitForCard(confirm);
      confirm.answer(card3.id, false);
      const denied = JSON.parse((await third).stdout) as {
        hookSpecificOutput: { decision: { behavior: string } };
      };
      expect(denied.hookSpecificOutput.decision.behavior).toBe('deny');

      const events = (await readFile(inbox, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events.filter((e) => e['ev'] === 'RemoteDecision').map((e) => e['type'])).toEqual([
        'allow',
        'defer',
        'deny',
      ]);
      // 收件箱里只有类别，没有命令原文
      expect(JSON.stringify(events)).not.toContain('private-name');
    } finally {
      bridge.stop();
    }
  }, 20_000);

  it('an auto-approve hit answers at once and never creates a pending file', async () => {
    const { hooks, bridge, run } = await setup();
    try {
      await writeFile(
        join(hooks, 'approve.json'),
        JSON.stringify({
          v: 1,
          rev: 2,
          enabled: true,
          grants: [
            { source: 'claude-code', project: 'D:/work/xinban', key: 'npm run lint', at: 1 },
          ],
          learnedThrough: 0,
        }),
      );
      const result = await run(ask);
      expect(JSON.parse(result.stdout).hookSpecificOutput.decision.behavior).toBe('allow');
      expect(result.ms).toBeLessThan(5_000);
      expect(await readdir(join(hooks, 'pending')).catch(() => [])).toEqual([]);
    } finally {
      bridge.stop();
    }
  }, 20_000);

  it('芯伴 closing mid-wait hands back to the terminal', async () => {
    const { hooks, confirm, bridge, run } = await setup();
    try {
      const pending = run(ask);
      await waitForCard(confirm);
      await rm(join(hooks, 'alive'));
      const result = await pending;
      expect(result.stdout).toBe('');
      expect(result.ms).toBeLessThan(5_000);
    } finally {
      bridge.stop();
    }
  }, 20_000);

  it('legacy sync spawn with remote off behaves like v4 (no output, no wait)', async () => {
    const { hooks, script, bridge, inbox } = await setup();
    bridge.stop();
    await writeFile(
      join(hooks, 'remote.json'),
      JSON.stringify({ v: 1, enabled: false, waitMs: 45_000 }),
    );
    const started = Date.now();
    const result = spawnSync(process.execPath, [script, 'claude', inbox], {
      input: JSON.stringify(ask),
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.stdout).toBe('');
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
