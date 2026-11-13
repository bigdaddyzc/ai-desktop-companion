import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  emptyDelegateSnapshot,
  type DelegateRecord,
  type DelegateSnapshot,
} from '../src/core/delegate';
import { hookLimits } from '../src/core/hook-events';
import type { WorkProgressState, WorkSession } from '../src/core/progress';
import {
  buildWorkbench,
  longWaitNudges,
  markSeen,
  normalizeSeen,
  workbenchLimits,
  workbenchSummary,
  type DelegateView,
} from '../src/core/workbench';
import {
  baselineNotes,
  buildReview,
  conclusionOf,
  editorProblem,
  openPathProblem,
  parseNumstat,
  parsePorcelain,
  testSummaryLines,
} from '../src/core/review';
import { gitBaseline, WorkbenchService, type GitRunner } from '../src/desktop/workbench';
import { followUpRequest } from '../src/renderer/WorkbenchCard';

const now = 1_800_000_000_000;

function session(over: Partial<WorkSession>): WorkSession {
  return {
    sessionId: 's',
    title: 't',
    project: 'demo',
    cwd: 'D:/work/demo',
    updatedAt: now - 1_000,
    status: 'idle' as WorkSession['status'],
    runningTool: '',
    steps: [],
    stepCount: 0,
    lastUserText: '',
    lastAssistantText: '',
    ...over,
  };
}

function progress(sessions: WorkSession[]): WorkProgressState {
  return { sessions, scannedAt: now, error: '' };
}

function record(over: Partial<DelegateRecord>): DelegateRecord {
  return {
    at: now - 60_000,
    target: 'WorkBuddy',
    project: 'shop',
    task: '修登录',
    outcome: 'ok',
    ms: 30_000,
    code: 0,
    error: '',
    cwd: 'D:/work/shop',
    summary: '登录修好了',
    tests: ['Tests  3 passed (3)'],
    ...over,
  };
}

const idleDelegate: DelegateView = { busy: false, current: null, history: [] };

describe('buildWorkbench', () => {
  const three = progress([
    session({
      sessionId: 'a',
      source: 'Codex',
      project: 'api',
      status: 'working' as WorkSession['status'],
      signal: 'working',
      signalAt: now - 5_000,
    }),
    session({
      sessionId: 'b',
      source: 'WorkBuddy',
      project: 'shop',
      signal: 'done',
      signalAt: now - 3_000,
      lastAssistantText: '都改完了',
    }),
    session({
      sessionId: 'c',
      source: 'Claude Code',
      project: 'xinban',
      signal: 'waiting',
      signalAt: now - 10_000,
      signalDetail: 'Bash',
    }),
  ]);

  it('等你 → 干完没看 → 在干，计数与摘要正确', () => {
    const bench = buildWorkbench({ progress: three, delegate: idleDelegate, seen: {}, now });
    expect(bench.items.map((item) => item.kind)).toEqual(['waiting', 'unseen', 'working']);
    expect(bench.items[0]!.title).toBe('xinban · Claude Code');
    expect(bench.items[0]!.detail).toContain('Bash');
    expect(bench.items[2]!.terminalOnly).toBe(true);
    expect(bench.counts).toMatchObject({ waiting: 1, unseen: 1, working: 1, error: 0 });
    expect(bench.summary).toBe('1 个等你 · 1 个待看');
  });

  it('看过的干完变空闲；之后又干完一轮重新算没看', () => {
    const seen = markSeen({}, 'WorkBuddy:b', now);
    const bench = buildWorkbench({ progress: three, delegate: idleDelegate, seen, now });
    expect(bench.items.find((item) => item.key === 'WorkBuddy:b')!.kind).toBe('idle');
    const later = progress([
      session({ sessionId: 'b', source: 'WorkBuddy', signal: 'done', signalAt: now + 5_000 }),
    ]);
    const again = buildWorkbench({
      progress: later,
      delegate: idleDelegate,
      seen,
      now: now + 6_000,
    });
    expect(again.items[0]!.kind).toBe('unseen');
  });

  it('等待超过 waitingFreshMs 不再算等你', () => {
    const stale = progress([
      session({ sessionId: 'c', signal: 'waiting', signalAt: now - hookLimits.waitingFreshMs - 1 }),
    ]);
    const bench = buildWorkbench({ progress: stale, delegate: idleDelegate, seen: {}, now });
    expect(bench.items[0]!.kind).toBe('idle');
    expect(bench.summary).toBe('');
  });

  it('派活：进行中算在干，失败算出错，成功带结论和测试，取消的不列', () => {
    const delegate: DelegateView = {
      busy: true,
      current: {
        at: now - 1_000,
        target: 'Claude Code',
        project: 'api',
        cwd: 'D:/api',
        task: '加接口',
      },
      history: [
        record({}),
        record({
          at: now - 120_000,
          outcome: 'failed',
          code: 1,
          error: '模型报错',
          summary: undefined,
        }),
        record({ at: now - 200_000, outcome: 'cancelled' }),
      ],
    };
    const bench = buildWorkbench({ progress: progress([]), delegate, seen: {}, now });
    expect(bench.items.map((item) => item.kind)).toEqual(['error', 'unseen', 'working']);
    expect(bench.items[0]!.result).toBe('模型报错');
    expect(bench.items[1]!.result).toBe('登录修好了');
    expect(bench.items[1]!.tests).toEqual(['Tests  3 passed (3)']);
    expect(bench.items[1]!.cwd).toBe('D:/work/shop');
    expect(bench.summary).toBe('1 个出错 · 1 个待看');
  });

  it('派出去的活走了钩子：会话并进派活那条，在等你时派活那条就是等你', () => {
    const started = now - 20_000;
    const delegate: DelegateView = {
      busy: true,
      current: {
        at: started,
        target: 'Claude Code',
        project: 'api',
        cwd: 'D:/api',
        task: '加接口',
      },
      history: [record({ at: now - 600_000 })],
    };
    const sessions = progress([
      session({
        sessionId: 'run',
        source: 'Claude Code',
        project: 'api',
        signal: 'waiting',
        signalAt: now - 5_000,
        signalDetail: 'Bash',
        delegateId: String(started),
      }),
      session({
        sessionId: 'old',
        source: 'WorkBuddy',
        project: 'shop',
        signal: 'done',
        signalAt: now - 500_000,
        delegateId: String(now - 600_000),
      }),
      // 对不上任何派活记录的：照常当会话。
      session({
        sessionId: 'lost',
        signal: 'done',
        signalAt: now - 1_000,
        delegateId: '1234567890123',
      }),
    ]);
    const bench = buildWorkbench({ progress: sessions, delegate, seen: {}, now });
    expect(bench.items.map((item) => item.key)).toEqual([
      `delegate:${started}`,
      'WorkBuddy:lost',
      `delegate:${now - 600_000}`,
    ]);
    expect(bench.items[0]).toMatchObject({ kind: 'waiting', detail: '在等你：Bash' });
    expect(bench.counts.waiting).toBe(1);
  });

  it('看过的派活记录不再列出', () => {
    const delegate: DelegateView = { busy: false, current: null, history: [record({})] };
    const key = `delegate:${now - 60_000}`;
    const bench = buildWorkbench({ progress: progress([]), delegate, seen: { [key]: now }, now });
    expect(bench.items).toEqual([]);
  });

  it('只在干的时候摘要说在干，没事是空串', () => {
    expect(workbenchSummary({ waiting: 0, error: 0, unseen: 0, working: 2, idle: 1 })).toBe(
      '2 个在干',
    );
    expect(workbenchSummary({ waiting: 0, error: 0, unseen: 0, working: 0, idle: 3 })).toBe('');
  });
});

describe('已看标记', () => {
  it('过期与超量的丢掉', () => {
    const old = { a: now - workbenchLimits.seenKeepMs - 1, b: now - 1_000 };
    expect(Object.keys(markSeen(old, 'c', now)).sort()).toEqual(['b', 'c']);
    const many: Record<string, number> = {};
    for (let i = 0; i < workbenchLimits.maxSeen + 20; i += 1) many[`k${i}`] = now - i;
    expect(Object.keys(markSeen(many, 'new', now))).toHaveLength(workbenchLimits.maxSeen);
  });

  it('normalizeSeen 只收数字', () => {
    expect(normalizeSeen({ a: 1, b: 'x', c: Number.NaN })).toEqual({ a: 1 });
    expect(normalizeSeen([1, 2])).toEqual({});
    expect(normalizeSeen(null)).toEqual({});
  });
});

describe('长等提醒', () => {
  it('等了 2 分钟以上、没看过的提一次，key 带进入等待的时刻', () => {
    const state = progress([
      session({
        sessionId: 'c',
        source: 'Claude Code',
        signal: 'waiting',
        signalAt: now - 3 * 60_000,
      }),
      session({ sessionId: 'd', source: 'Claude Code', signal: 'waiting', signalAt: now - 30_000 }),
    ]);
    const bench = buildWorkbench({ progress: state, delegate: idleDelegate, seen: {}, now });
    const nudges = longWaitNudges(bench, {}, now);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]!.key).toBe(`waiting-long:Claude Code:c:${now - 3 * 60_000}`);
    expect(longWaitNudges(bench, { 'Claude Code:c': now }, now)).toEqual([]);
  });
});

describe('review 解析', () => {
  it('porcelain -z：重命名取新路径，跳过旧路径', () => {
    const raw = ' M src/a.ts\0R  src/new.ts\0src/old.ts\0?? notes.md\0';
    expect(parsePorcelain(raw)).toEqual([
      { status: ' M', path: 'src/a.ts' },
      { status: 'R ', path: 'src/new.ts' },
      { status: '??', path: 'notes.md' },
    ]);
  });

  it('numstat -z：二进制是 null，重命名用新路径', () => {
    const raw = '3\t1\tsrc/a.ts\0-\t-\tlogo.png\0' + '2\t0\t\0src/old.ts\0src/new.ts\0';
    const stats = parseNumstat(raw);
    expect(stats.get('src/a.ts')).toEqual({ added: 3, deleted: 1 });
    expect(stats.get('logo.png')).toEqual({ added: null, deleted: null });
    expect(stats.get('src/new.ts')).toEqual({ added: 2, deleted: 0 });
  });

  it('buildReview 合计增删，干净工作区有说明', () => {
    const review = buildReview(' M src/a.ts\0?? b.md\0', '3\t1\tsrc/a.ts\0', false);
    expect(review).toMatchObject({ status: 'git', added: 3, deleted: 1, truncated: false });
    expect(review.files[1]).toEqual({ path: 'b.md', status: '??', added: null, deleted: null });
    expect(buildReview('', '', false).note).toContain('干净');
  });

  it('测试摘要：认 vitest/pytest/maven/go/cargo，最多 3 条，认不出是空', () => {
    const out = [
      '\u001b[32m Tests  12 passed (12)\u001b[0m',
      '======= 4 passed, 1 failed in 2.31s =======',
      '[INFO] Tests run: 8, Failures: 0, Errors: 0, Skipped: 0',
      'ok  \tgithub.com/x/y\t0.12s',
      'test result: ok. 5 passed; 0 failed',
      'random line',
    ].join('\n');
    const lines = testSummaryLines(out);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('test result: ok. 5 passed; 0 failed');
    expect(testSummaryLines('写完了，没跑测试')).toEqual([]);
  });

  it('结论取最后一段', () => {
    expect(conclusionOf('第一段\n\n第二段\n继续\n\n  \n')).toBe('第二段 继续');
    expect(conclusionOf('')).toBe('');
  });

  it('编辑器命令与目录拒绝 cmd 元字符', () => {
    expect(editorProblem('code')).toBe('');
    expect(editorProblem('C:\\Program Files\\Cursor\\cursor.exe')).toBe('');
    expect(editorProblem('code & calc')).not.toBe('');
    expect(editorProblem('  ')).not.toBe('');
    expect(openPathProblem('D:\\work\\demo')).toBe('');
    expect(openPathProblem('D:\\a&b')).not.toBe('');
    expect(openPathProblem('')).not.toBe('');
  });

  it('再派一项：带上 Agent 与项目，说明是新任务', () => {
    expect(followUpRequest({ agent: 'WorkBuddy', project: 'shop' }, ' 再加个测试 ')).toBe(
      '在 shop 项目里再派一项给 WorkBuddy（新任务，不接原会话）：再加个测试',
    );
  });

  it('工作区说明：没基线、开工前已有改动、HEAD 变了各说各的', () => {
    expect(baselineNotes(undefined, 'abc1234')[0]).toContain('可能包含你或其他任务');
    expect(baselineNotes({ head: 'abc1234', dirty: 3 }, 'abc1234')).toEqual([
      '开工时已有 3 个文件未提交：下面的改动不全是这次派活做的。',
    ]);
    const moved = baselineNotes({ head: 'abc1234', dirty: 0 }, 'def5678');
    expect(moved[0]).toContain('干净');
    expect(moved[1]).toContain('HEAD 变了');
  });

  it('gitBaseline：只读取 HEAD 与未提交数；不是仓库、空仓库都不记', async () => {
    const cwd = process.cwd();
    const repo = await gitBaseline(cwd, async (args) =>
      args[0] === 'rev-parse'
        ? { ok: true, stdout: 'abc1234def\n', truncated: false }
        : { ok: true, stdout: ' M a.ts\0?? b.md\0', truncated: false },
    );
    expect(repo).toEqual({ head: 'abc1234def', dirty: 2 });
    const none = await gitBaseline(cwd, async () => ({ ok: false, stdout: '', truncated: false }));
    expect(none).toBeNull();
    expect(
      await gitBaseline('Z:\\no\\such\\dir', async () => ({
        ok: true,
        stdout: 'x',
        truncated: false,
      })),
    ).toBeNull();
  });
});

describe('WorkbenchService', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });

  async function service(git: GitRunner, opened: string[] = []) {
    dir = await mkdtemp(join(tmpdir(), 'xinban-bench-'));
    const delegate: DelegateSnapshot = {
      ...emptyDelegateSnapshot(),
      history: [record({ cwd: dir })],
    };
    const svc = new WorkbenchService(
      join(dir, 'workbench-v1.json'),
      () => progress([]),
      () => delegate,
      () => now,
      git,
      async (editor, path) => {
        opened.push(`${editor}|${path}`);
        return true;
      },
    );
    await svc.load();
    return svc;
  }

  it('已看写盘，重启后不丢；不在工作台上的 key 拒绝', async () => {
    const svc = await service(async () => ({ ok: true, stdout: '', truncated: false }));
    const key = svc.state().items[0]!.key;
    expect(svc.state().counts.unseen).toBe(1);
    expect(await svc.markSeen('nope')).toBe(false);
    expect(await svc.markSeen(key)).toBe(true);
    expect(svc.state().items).toEqual([]);
    const saved = JSON.parse(await readFile(join(dir, 'workbench-v1.json'), 'utf8'));
    expect(saved.seen[key]).toBe(now);
    const again = new WorkbenchService(
      join(dir, 'workbench-v1.json'),
      () => progress([]),
      () => ({
        ...emptyDelegateSnapshot(),
        history: [record({ cwd: dir })],
      }),
      () => now,
    );
    await again.load();
    expect(again.state().items).toEqual([]);
  });

  it('review：只跑固定只读参数，非仓库给说明', async () => {
    const calls: string[] = [];
    const svc = await service(async (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'rev-parse') return { ok: true, stdout: 'true\n', truncated: false };
      if (args[0] === 'status') return { ok: true, stdout: ' M a.ts\0', truncated: false };
      return { ok: true, stdout: '1\t2\ta.ts\0', truncated: false };
    });
    const key = svc.state().items[0]!.key;
    const review = await svc.review(key);
    expect(review).toMatchObject({ status: 'git', added: 1, deleted: 2 });
    expect(
      calls.some((call) => call.startsWith('diff --numstat') && call.includes('--no-ext-diff')),
    ).toBe(true);
    expect(await svc.review('nope')).toBeNull();

    const plain = await service(async (args) =>
      args[0] === '--version'
        ? { ok: true, stdout: 'git version 2', truncated: false }
        : { ok: false, stdout: '', truncated: false },
    );
    const plainKey = plain.state().items[0]!.key;
    expect((await plain.review(plainKey))?.status).toBe('not-git');
  });

  it('打开编辑器用配置的命令；坏命令存不进去', async () => {
    const opened: string[] = [];
    const svc = await service(async () => ({ ok: true, stdout: '', truncated: false }), opened);
    const key = svc.state().items[0]!.key;
    expect(await svc.openEditor(key)).toEqual({ ok: true });
    expect(opened).toEqual([`code|${dir}`]);
    expect((await svc.setEditor('code && calc')).ok).toBe(false);
    expect(await svc.setEditor('cursor')).toEqual({ ok: true });
    expect(svc.state().config.editor).toBe('cursor');
  });
});
