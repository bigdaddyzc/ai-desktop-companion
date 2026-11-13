import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultDelegate,
  delegateChain,
  delegatePrompt,
  delegateUnavailable,
  normalizeDelegate,
  type DelegateAvailability,
  type DelegateConfig,
} from '../src/core/delegate';
import { applyHookSignals, parseHookEvents } from '../src/core/hook-events';
import { emptyProgress } from '../src/core/progress';
import { DelegateService, DelegateStore } from '../src/desktop/delegate';
import type { RunOptions, RunResult } from '../src/desktop/delegate';

const on: DelegateConfig = { ...defaultDelegate, allowAgents: true, customArgs: [] };

const all: DelegateAvailability[] = [
  { id: 'workbuddy', label: 'WorkBuddy', available: true, path: 'w' },
  { id: 'claude', label: 'Claude Code', available: true, path: 'c' },
  { id: 'codex', label: 'Codex', available: true, path: 'x' },
  { id: 'custom', label: '自定义命令', available: true, path: 'z' },
];

describe('delegateChain', () => {
  const none = new Set<never>();

  it('自动挑：Claude Code → Codex → WorkBuddy，自定义不进自动链', () => {
    expect(delegateChain({ config: on, available: all, cooling: none })).toEqual([
      'claude',
      'codex',
      'workbuddy',
    ]);
  });

  it('点名的排第一；没装的不进备选', () => {
    const some = all.map((item) => (item.id === 'claude' ? { ...item, available: false } : item));
    expect(
      delegateChain({ config: on, requested: 'workbuddy', available: some, cooling: none }),
    ).toEqual(['workbuddy', 'codex']);
    // 点了名但没探测到：仍试它（会报没装），再换。
    expect(
      delegateChain({ config: on, requested: 'claude', available: some, cooling: none }),
    ).toEqual(['claude', 'codex', 'workbuddy']);
  });

  it('最近用不了的排后；关了自动换只试一个；面板定了具体的就它先', () => {
    expect(delegateChain({ config: on, available: all, cooling: new Set(['claude']) })).toEqual([
      'codex',
      'workbuddy',
      'claude',
    ]);
    expect(
      delegateChain({ config: { ...on, fallback: false }, available: all, cooling: none }),
    ).toEqual(['claude']);
    expect(
      delegateChain({ config: { ...on, target: 'codex' }, available: all, cooling: none }),
    ).toEqual(['codex', 'claude', 'workbuddy']);
  });

  it('一个都没探测到时仍给出一个，让它报「没装」', () => {
    expect(delegateChain({ config: on, available: [], cooling: none })).toEqual(['claude']);
  });
});

describe('钩子事件带派活 ID', () => {
  it('解析出 job，叠到会话上成为 delegateId；不是纯数字的不认', () => {
    const at = 1_800_000_000_000;
    const lines = [
      {
        v: 1,
        src: 'claude',
        ev: 'UserPromptSubmit',
        sid: 's1',
        cwd: 'D:/w/api',
        at,
        job: '1799999990000',
      },
      {
        v: 1,
        src: 'claude',
        ev: 'PermissionRequest',
        sid: 's1',
        cwd: 'D:/w/api',
        at: at + 1,
        tool: 'Bash',
      },
      { v: 1, src: 'claude', ev: 'Stop', sid: 's2', cwd: 'D:/w/api', at, job: 'rm -rf' },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n');
    const signals = parseHookEvents(lines);
    expect(signals.find((s) => s.sessionId === 's1')?.job).toBe('1799999990000');
    expect(signals.find((s) => s.sessionId === 's2')?.job).toBe('');
    const state = applyHookSignals(emptyProgress(at), signals, at + 2);
    expect(state.sessions.find((s) => s.sessionId === 's1')).toMatchObject({
      delegateId: '1799999990000',
      signal: 'waiting',
    });
    expect(state.sessions.find((s) => s.sessionId === 's2')?.delegateId).toBeUndefined();
  });
});

describe('配置与提示词', () => {
  it('默认自动挑、自动换；老配置里的默认 workbuddy 升级成自动，点过的保留', () => {
    expect(normalizeDelegate({})).toMatchObject({ target: 'auto', fallback: true });
    expect(normalizeDelegate({ target: 'workbuddy' }).target).toBe('auto');
    expect(normalizeDelegate({ target: 'workbuddy', fallback: true }).target).toBe('workbuddy');
    expect(normalizeDelegate({ target: 'codex' }).target).toBe('codex');
    expect(normalizeDelegate({ fallback: false }).fallback).toBe(false);
  });

  it('自动挑时把各自特长和自动换告诉模型', () => {
    const prompt = delegatePrompt(on, all);
    expect(prompt).toContain('target=claude');
    expect(prompt).toContain('自动换下一个');
    expect(delegatePrompt({ ...on, target: 'codex', fallback: false }, all)).not.toContain(
      '自动换下一个',
    );
  });

  it('只有没登录、上游出错算「用不了」', () => {
    expect(delegateUnavailable('Error: not logged in')).toBe(true);
    expect(delegateUnavailable('API Error: 429 rate limit')).toBe(true);
    expect(delegateUnavailable('test failed: expected 2 got 3')).toBe(false);
  });
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const ok = (stdout: string): RunResult => ({
  code: 0,
  stdout,
  stderr: '',
  timedOut: false,
  spawnError: '',
});

/** 假执行器：`where` 按 installed 回答，派活按程序名回答。 */
async function service(
  installed: string[],
  answers: Record<string, RunResult>,
  config: Partial<DelegateConfig> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'xinban-fallback-'));
  directories.push(dir);
  const store = new DelegateStore(join(dir, 'delegate-v1.json'));
  await store.save({ ...on, ...config });
  const runs: string[] = [];
  const runner = async (options: RunOptions): Promise<RunResult> => {
    if (options.command === 'where') {
      const bin = options.args[0] ?? '';
      return installed.includes(bin) ? ok(`C:\\npm\\${bin}.cmd\r\n`) : { ...ok(''), code: 1 };
    }
    const bin = /([a-z]+)\.cmd$/.exec(options.command)?.[1] ?? options.command;
    runs.push(bin);
    // 本机可能真装着 WorkBuddy（按安装目录找到，由 node 跑）：'*' 给它们一个统一回答。
    return answers[bin] ?? answers['*'] ?? ok('干完了');
  };
  const svc = new DelegateService(store, dir, runner);
  await svc.init();
  return { svc, runs };
}

const signal = new AbortController().signal;
const notLoggedIn: RunResult = {
  code: 1,
  stdout: '',
  stderr: 'Error: not logged in',
  timedOut: false,
  spawnError: '',
};

describe('DelegateService 自动换', () => {
  it('没点名：第一个没登录就换 Codex，结果写明换了谁', async () => {
    const { svc, runs } = await service(['claude', 'codex'], {
      claude: notLoggedIn,
      codex: ok('修好了'),
    });
    const result = await svc.run({ task: '修一下登录 bug' }, signal);
    expect(runs).toEqual(['claude', 'codex']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toBe('Codex');
      expect(result.text).toContain('Claude Code 没登录，改派给 Codex');
    }
    const history = svc.snapshot().history;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ target: 'Codex', outcome: 'ok' });
  });

  it('点名的用不了也换；下一次自动挑时把刚才用不了的排后', async () => {
    const { svc, runs } = await service(['claude', 'codex'], { claude: notLoggedIn });
    const first = await svc.run({ task: '补个测试', target: 'claude' }, signal);
    expect(first.ok).toBe(true);
    runs.length = 0;
    await svc.run({ task: '再补一个' }, signal);
    expect(runs).toEqual(['codex']);
  });

  it('干了但没干成不换：可能已经改了文件', async () => {
    const failed: RunResult = {
      code: 1,
      stdout: '改了三个文件，测试没过',
      stderr: '',
      timedOut: false,
      spawnError: '',
    };
    const { svc, runs } = await service(['claude', 'codex'], { claude: failed });
    const result = await svc.run({ task: '修 bug' }, signal);
    expect(result.ok).toBe(false);
    expect(runs).toEqual(['claude']);
  });

  it('超时不换', async () => {
    const slow: RunResult = {
      code: null,
      stdout: '干到一半',
      stderr: '',
      timedOut: true,
      spawnError: '',
    };
    const { svc, runs } = await service(['claude', 'codex'], { claude: slow });
    expect((await svc.run({ task: '修 bug' }, signal)).ok).toBe(false);
    expect(runs).toEqual(['claude']);
  });

  it('都用不了：一句话说清试了哪些', async () => {
    const { svc } = await service(['claude', 'codex'], {
      claude: notLoggedIn,
      codex: notLoggedIn,
      '*': notLoggedIn,
    });
    const result = await svc.run({ task: '修 bug' }, signal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Claude Code 没登录');
      expect(result.error).toContain('Codex 没登录');
    }
  });

  it('模型服务出错：还没产出就换，已经干到一半不换（不自动重试付费任务）', async () => {
    const limited = (stdout: string): RunResult => ({
      code: 1,
      stdout,
      stderr: 'API Error: 429 rate limit',
      timedOut: false,
      spawnError: '',
    });
    const early = await service(['claude', 'codex'], { claude: limited('') });
    expect((await early.svc.run({ task: '修 bug' }, signal)).ok).toBe(true);
    expect(early.runs).toEqual(['claude', 'codex']);

    const late = await service(['claude', 'codex'], {
      claude: limited('改了两个文件，正在跑测试'),
    });
    const result = await late.svc.run({ task: '修 bug' }, signal);
    expect(result.ok).toBe(false);
    expect(late.runs).toEqual(['claude']);
  });

  it('派活 ID 进子进程环境，开工基线进记录', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xinban-fallback-'));
    directories.push(dir);
    const store = new DelegateStore(join(dir, 'delegate-v1.json'));
    await store.save(on);
    const envs: (Record<string, string> | undefined)[] = [];
    const runner = async (options: RunOptions): Promise<RunResult> => {
      if (options.command === 'where') return ok(`C:\\npm\\${options.args[0]}.cmd\r\n`);
      envs.push(options.env);
      return ok('干完了');
    };
    const svc = new DelegateService(store, dir, runner, undefined, async () => ({
      head: 'abc1234',
      dirty: 2,
    }));
    await svc.init();
    const result = await svc.run({ task: '补测试', target: 'claude' }, signal);
    expect(result.ok).toBe(true);
    const record = svc.snapshot().history[0]!;
    expect(envs[0]?.['XINBAN_DELEGATE_ID']).toBe(String(record.at));
    expect(record.baseline).toEqual({ head: 'abc1234', dirty: 2 });
  });

  it('关了自动换就只试一个', async () => {
    const { svc, runs } = await service(
      ['claude', 'codex'],
      { claude: notLoggedIn },
      { fallback: false },
    );
    expect((await svc.run({ task: '修 bug' }, signal)).ok).toBe(false);
    expect(runs).toEqual(['claude']);
  });
});
