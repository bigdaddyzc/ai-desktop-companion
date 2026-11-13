import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyHookSignals, parseHookEvents } from '../src/core/hook-events';
import {
  claudeHookCommand,
  claudeHookEvents,
  claudeHooksStatus,
  codexNotifyArgv,
  codexNotifyStatus,
  installClaudeHooks,
  installCodexNotify,
  parseClaudeSettings,
  uninstallClaudeHooks,
  uninstallCodexNotify,
} from '../src/core/hook-install';
import { detectWorkNudges } from '../src/core/nudge-sources';
import {
  describeSession,
  emptyProgress,
  shortActivity,
  type WorkSession,
} from '../src/core/progress';
import { HookInbox, HookInstaller, inboxPath } from '../src/desktop/hooks';
import { ProgressService, type ProgressSource } from '../src/desktop/progress';

const scriptSource = fileURLToPath(new URL('../src/desktop/hook/xinban-hook.cjs', import.meta.url));

const T0 = Date.parse('2026-11-09T10:00:00Z');

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify({ v: 1, ...record })}\n`;
}

function claude(ev: string, at: number, extra: Record<string, unknown> = {}): string {
  return line({ src: 'claude', ev, sid: 's1', cwd: 'D:\\work\\shop-api', at, ...extra });
}

describe('parseHookEvents', () => {
  it('a late or repeated SessionStart does not knock a working session back to ready', () => {
    // CodeBuddy 实测顺序：UserPromptSubmit → SessionStart → Stop。
    const raw = claude('UserPromptSubmit', T0) + claude('SessionStart', T0 + 1);
    expect(parseHookEvents(raw)[0]).toMatchObject({ kind: 'working' });
    const resumed = claude('Stop', T0) + claude('SessionStart', T0 + 1);
    expect(parseHookEvents(resumed)[0]).toMatchObject({ kind: 'done' });
    expect(parseHookEvents(claude('SessionStart', T0))[0]).toMatchObject({ kind: 'ready' });
    // 登录成功之类的通知不算「等你」。
    const auth =
      claude('UserPromptSubmit', T0) + claude('Notification', T0 + 1, { type: 'auth_success' });
    expect(parseHookEvents(auth)[0]).toMatchObject({ kind: 'working' });
  });

  it('WorkBuddy events use the Claude Code mapping but keep their own source', () => {
    const raw =
      line({ src: 'workbuddy', ev: 'UserPromptSubmit', sid: 's1', cwd: 'D:/a', at: T0 }) +
      line({ src: 'workbuddy', ev: 'PermissionRequest', sid: 's1', at: T0 + 1, tool: 'Bash' }) +
      claude('Stop', T0 + 2);
    const signals = parseHookEvents(raw);
    expect(signals).toHaveLength(2);
    expect(signals.find((s) => s.source === 'workbuddy')).toMatchObject({
      kind: 'waiting',
      detail: 'Bash',
    });
    expect(signals.find((s) => s.source === 'claude-code')).toMatchObject({ kind: 'done' });
    const state = applyHookSignals(emptyProgress(T0), signals, T0 + 10);
    expect(state.sessions[0]).toMatchObject({ source: 'WorkBuddy', signal: 'waiting' });
  });

  it('folds Claude Code events into the latest state per session', () => {
    const raw =
      claude('SessionStart', T0) +
      claude('UserPromptSubmit', T0 + 1_000) +
      claude('PermissionRequest', T0 + 2_000, { tool: 'Bash' });
    const [signal] = parseHookEvents(raw);
    expect(signal).toMatchObject({
      sessionId: 's1',
      source: 'claude-code',
      kind: 'waiting',
      detail: 'Bash',
      since: T0 + 2_000,
      cwd: 'D:\\work\\shop-api',
    });
  });

  it('approval then more tool use clears waiting; Stop means done', () => {
    const raw =
      claude('PermissionRequest', T0, { tool: 'Bash' }) +
      claude('PostToolUse', T0 + 5_000, { tool: 'Bash' }) +
      claude('Stop', T0 + 9_000);
    const [signal] = parseHookEvents(raw);
    expect(signal?.kind).toBe('done');
    expect(signal?.since).toBe(T0 + 9_000);
  });

  it('repeated events in the same state keep the original since (dedupe key stays stable)', () => {
    const raw =
      claude('PermissionRequest', T0, { tool: 'Bash' }) +
      claude('Notification', T0 + 6_000, { type: 'permission_prompt', msg: 'needs permission' });
    const [signal] = parseHookEvents(raw);
    expect(signal?.kind).toBe('waiting');
    expect(signal?.since).toBe(T0);
    expect(signal?.lastAt).toBe(T0 + 6_000);
  });

  it('idle_prompt after Stop does not turn done back into waiting', () => {
    const raw = claude('Stop', T0) + claude('Notification', T0 + 60_000, { type: 'idle_prompt' });
    expect(parseHookEvents(raw)[0]?.kind).toBe('done');
  });

  it('reads Codex agent-turn-complete as done and ignores junk lines', () => {
    const raw =
      'not json\n' +
      line({ src: 'codex', ev: 'agent-turn-complete', sid: 'th-9', cwd: '/w/app', at: T0 }) +
      line({ src: 'claude', ev: 'Stop', sid: '', at: T0 }) +
      JSON.stringify({ v: 2, src: 'claude', ev: 'Stop', sid: 'x', at: T0 }) +
      '\n{"v":1,"src":"claude","ev":"Sto';
    const signals = parseHookEvents(raw);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ source: 'codex', kind: 'done', sessionId: 'th-9' });
  });
});

function logSession(over: Partial<WorkSession> = {}): WorkSession {
  return {
    sessionId: 's1',
    source: 'Claude Code',
    title: '修支付回调',
    project: 'shop-api',
    cwd: 'D:\\work\\shop-api',
    updatedAt: T0,
    status: 'working',
    runningTool: '',
    steps: [],
    stepCount: 0,
    lastUserText: '',
    lastAssistantText: '',
    ...over,
  };
}

describe('applyHookSignals', () => {
  it('decorates a matching log session and keeps its title', () => {
    const state = { ...emptyProgress(T0 + 3_000), sessions: [logSession()] };
    const signals = parseHookEvents(claude('PermissionRequest', T0 + 2_000, { tool: 'Bash' }));
    const next = applyHookSignals(state, signals, T0 + 3_000);
    expect(next.sessions[0]).toMatchObject({
      title: '修支付回调',
      signal: 'waiting',
      signalDetail: 'Bash',
      updatedAt: T0 + 2_000,
    });
    expect(shortActivity(next.sessions[0]!)).toBe('在等你确认');
    expect(describeSession(next.sessions[0]!, T0 + 3_000)).toContain('在等你确认（Bash）');
  });

  it('creates a minimal session when logs are off, with no conversation text', () => {
    const signals = parseHookEvents(claude('Stop', T0));
    const next = applyHookSignals(emptyProgress(T0 + 1_000), signals, T0 + 1_000);
    expect(next.sessions).toHaveLength(1);
    expect(next.sessions[0]).toMatchObject({
      source: 'Claude Code',
      title: 'shop-api',
      project: 'shop-api',
      signal: 'done',
      lastUserText: '',
      lastAssistantText: '',
    });
  });

  it('matches Codex rollout files by thread-id suffix', () => {
    const state = {
      ...emptyProgress(T0),
      sessions: [logSession({ sessionId: 'rollout-2026-11-09T10-00-00-th-9', source: 'Codex' })],
    };
    const signals = parseHookEvents(
      line({ src: 'codex', ev: 'agent-turn-complete', sid: 'th-9', cwd: '/w', at: T0 }),
    );
    const next = applyHookSignals(state, signals, T0);
    expect(next.sessions).toHaveLength(1);
    expect(next.sessions[0]?.signal).toBe('done');
  });

  it('SessionEnd removes the session; stale signals are ignored', () => {
    const state = { ...emptyProgress(T0), sessions: [logSession()] };
    const ended = applyHookSignals(state, parseHookEvents(claude('SessionEnd', T0)), T0);
    expect(ended.sessions).toHaveLength(0);
    const old = applyHookSignals(
      emptyProgress(T0 + 7 * 3_600_000),
      parseHookEvents(claude('Stop', T0)),
      T0 + 7 * 3_600_000,
    );
    expect(old.sessions).toHaveLength(0);
  });

  it('puts waiting sessions first', () => {
    const raw =
      claude('Stop', T0 + 5_000) +
      line({
        src: 'claude',
        ev: 'PermissionRequest',
        sid: 's2',
        cwd: '/w/b',
        at: T0,
        tool: 'Edit',
      });
    const next = applyHookSignals(emptyProgress(T0 + 6_000), parseHookEvents(raw), T0 + 6_000);
    expect(next.sessions.map((session) => session.sessionId)).toEqual(['s2', 's1']);
  });
});

describe('detectWorkNudges with hook signals', () => {
  const at = (sessions: WorkSession[], scannedAt: number) => ({
    ...emptyProgress(scannedAt),
    sessions,
  });

  it('waiting nudges once per waiting episode', () => {
    const waiting = logSession({ signal: 'waiting', signalAt: T0 });
    const first = detectWorkNudges(at([], T0), at([waiting], T0 + 1_000));
    expect(first).toEqual([
      expect.objectContaining({ kind: 'agent-waiting', key: `waiting:s1:${T0}` }),
    ]);
    expect(detectWorkNudges(at([waiting], T0), at([waiting], T0 + 5_000))).toEqual([]);
  });

  it('done nudges only when fresh, and hook sessions skip log heuristics', () => {
    const done = logSession({ signal: 'done', signalAt: T0, status: 'resting' });
    const before = logSession({ signal: 'working', signalAt: T0 - 9_000, status: 'working' });
    expect(detectWorkNudges(at([before], T0), at([done], T0 + 1_000))).toEqual([
      expect.objectContaining({ kind: 'agent-stopped' }),
    ]);
    // 启动时才看到一个半小时前的「做完了」：不提。
    expect(detectWorkNudges(at([], T0 + 1_800_000), at([done], T0 + 1_800_000))).toEqual([]);
    // 钩子会话里即使 runningTool 像「问用户」，也不再走猜测。
    const guessy = logSession({ signal: 'working', signalAt: T0, runningTool: 'AskUserQuestion' });
    expect(detectWorkNudges(at([], T0), at([guessy], T0))).toEqual([]);
  });
});

describe('Claude Code settings merge', () => {
  const command = claudeHookCommand(
    'node',
    'C:\\Data\\hooks\\xinban-hook.cjs',
    'C:\\Data\\in.ndjson',
  );

  it('uses forward slashes so Git Bash does not eat backslashes', () => {
    expect(command).toBe('node "C:/Data/hooks/xinban-hook.cjs" claude "C:/Data/in.ndjson"');
  });

  it('installs observers async but PermissionRequest sync, keeps user hooks, and is idempotent', () => {
    const user = {
      model: 'opus',
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
      },
    };
    const once = installClaudeHooks(user, command);
    const twice = installClaudeHooks(once, command);
    expect(twice).toEqual(once);
    expect(claudeHooksStatus(once)).toBe('installed');
    const hooks = once['hooks'] as Record<string, unknown[]>;
    expect(hooks['Stop']).toHaveLength(2);
    expect(hooks['Stop']![0]).toEqual(user.hooks.Stop[0]);
    expect(hooks['PreToolUse']).toEqual(user.hooks.PreToolUse);
    for (const event of claudeHookEvents) {
      // 替你确认要当场答复：权限请求同步跑，其余只是旁观。
      expect(hooks[event]!.at(-1)).toEqual({
        hooks: [
          event === 'PermissionRequest'
            ? { type: 'command', command, timeout: 95 }
            : { type: 'command', command, async: true, timeout: 10 },
        ],
      });
    }
    expect(once['model']).toBe('opus');
  });

  it('an old async PermissionRequest install counts as partial (needs reinstall)', () => {
    const installed = installClaudeHooks({}, command);
    const hooks = { ...(installed['hooks'] as Record<string, unknown>) };
    hooks['PermissionRequest'] = [
      { hooks: [{ type: 'command', command, async: true, timeout: 10 }] },
    ];
    expect(claudeHooksStatus({ hooks })).toBe('partial');
    expect(claudeHooksStatus(installClaudeHooks({ hooks }, command))).toBe('installed');
  });

  it('a v4 install with the 10s sync timeout counts as partial (remote approval needs 95s)', () => {
    const installed = installClaudeHooks({}, command);
    const hooks = { ...(installed['hooks'] as Record<string, unknown>) };
    hooks['PermissionRequest'] = [{ hooks: [{ type: 'command', command, timeout: 10 }] }];
    expect(claudeHooksStatus({ hooks })).toBe('partial');
    expect(claudeHooksStatus(installClaudeHooks({ hooks }, command))).toBe('installed');
  });

  it('uninstall restores the original shape', () => {
    const user = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };
    expect(uninstallClaudeHooks(installClaudeHooks(user, command))).toEqual(user);
    expect(uninstallClaudeHooks(installClaudeHooks({}, command))).toEqual({});
  });

  it('detects partial installs and refuses unreadable settings', () => {
    const installed = installClaudeHooks({}, command);
    const hooks = { ...(installed['hooks'] as Record<string, unknown>) };
    delete hooks['Stop'];
    expect(claudeHooksStatus({ hooks })).toBe('partial');
    expect(parseClaudeSettings('').ok).toBe(true);
    expect(parseClaudeSettings('{ broken').ok).toBe(false);
    expect(parseClaudeSettings('[1,2]').ok).toBe(false);
    expect(parseClaudeSettings('{"hooks": []}').ok).toBe(false);
  });
});

describe('Codex notify merge', () => {
  const argv = codexNotifyArgv('node', 'C:\\D\\xinban-hook.cjs', 'C:\\D\\in.ndjson');

  it('adds notify at top level, before any table', () => {
    const result = installCodexNotify('model = "o4"\n\n[tui]\nnotifications = true\n', argv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = result.value.split('\n');
    expect(lines[0]).toBe(
      'notify = ["node", "C:/D/xinban-hook.cjs", "codex", "C:/D/in.ndjson"] # xinban-hook',
    );
    expect(lines.indexOf('[tui]')).toBeGreaterThan(0);
    expect(codexNotifyStatus(result.value)).toBe('installed');
    expect(uninstallCodexNotify(result.value)).toBe(
      'model = "o4"\n\n[tui]\nnotifications = true\n',
    );
  });

  it('never overwrites a user notify; a notify inside a table is not top-level', () => {
    const mine = 'notify = ["python3", "n.py"]\n';
    expect(installCodexNotify(mine, argv).ok).toBe(false);
    expect(codexNotifyStatus(mine)).toBe('conflict');
    expect(uninstallCodexNotify(mine)).toBe(mine);
    expect(codexNotifyStatus('[profiles.x]\nnotify = ["a"]\n')).toBe('absent');
  });

  it('re-install replaces our own line and keeps CRLF', () => {
    const first = installCodexNotify('a = 1\r\n', argv);
    if (!first.ok) throw new Error('install failed');
    const second = installCodexNotify(first.value, argv);
    expect(second).toEqual(first);
    expect(first.value).toContain('\r\n');
  });
});

describe('hook script + installer on disk', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xinban-hooks-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function installer(): HookInstaller {
    return new HookInstaller(
      {
        dataDir: join(dir, 'data'),
        claudeHome: join(dir, '.claude'),
        codexHome: join(dir, '.codex'),
        workbuddyHome: join(dir, '.workbuddy'),
        codebuddyHome: join(dir, '.codebuddy'),
        scriptSource,
      },
      () => T0,
      async () => true,
    );
  }

  it('installs into existing settings with a backup and uninstalls cleanly', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    const original = JSON.stringify({ theme: 'dark' });
    await writeFile(join(dir, '.claude', 'settings.json'), original);
    const hooks = installer();
    expect(await hooks.apply('claude-code', 'install')).toEqual({ ok: true });
    const status = await hooks.status();
    expect(status.claudeCode.status).toBe('installed');
    const files = await readdir(join(dir, '.claude'));
    expect(files.some((name) => name.startsWith('settings.json.xinban-bak-'))).toBe(true);
    const script = await readFile(join(dir, 'data', 'hooks', 'xinban-hook.cjs'), 'utf8');
    expect(script).toBe(await readFile(scriptSource, 'utf8'));
    expect(await hooks.apply('claude-code', 'uninstall')).toEqual({ ok: true });
    const after = JSON.parse(await readFile(join(dir, '.claude', 'settings.json'), 'utf8'));
    expect(after).toEqual({ theme: 'dark' });
  });

  it('refuses to touch broken settings.json or a user notify', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(join(dir, '.claude', 'settings.json'), '{ nope');
    await mkdir(join(dir, '.codex'), { recursive: true });
    await writeFile(join(dir, '.codex', 'config.toml'), 'notify = ["mine"]\n');
    const hooks = installer();
    expect((await hooks.apply('claude-code', 'install')).ok).toBe(false);
    expect((await hooks.apply('codex', 'install')).ok).toBe(false);
    expect(await readFile(join(dir, '.claude', 'settings.json'), 'utf8')).toBe('{ nope');
    expect(await readFile(join(dir, '.codex', 'config.toml'), 'utf8')).toBe('notify = ["mine"]\n');
    const status = await hooks.status();
    expect(status.claudeCode.status).toBe('unreadable');
    expect(status.codex.status).toBe('conflict');
  });

  it('WorkBuddy: installs into ~/.workbuddy/settings.json, keeps its own keys, tags events as workbuddy', async () => {
    await mkdir(join(dir, '.workbuddy'), { recursive: true });
    // WorkBuddy 桌面版自己也写这个文件：它的键一个都不能丢。
    const own = { sandbox: { enabled: true }, enabledPlugins: ['a'], autoLaunchDesired: false };
    await writeFile(join(dir, '.workbuddy', 'settings.json'), JSON.stringify(own));
    const hooks = installer();
    expect((await hooks.status()).workbuddy.status).toBe('absent');
    expect(await hooks.apply('workbuddy', 'install')).toEqual({ ok: true });
    const installed = JSON.parse(
      await readFile(join(dir, '.workbuddy', 'settings.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(installed).toMatchObject(own);
    expect(JSON.stringify(installed['hooks'])).toContain(' workbuddy ');
    expect((await hooks.status()).workbuddy.status).toBe('installed');
    // 别家不受影响；CodeBuddy 命令行单独装，同样记成 workbuddy 来源。
    expect((await hooks.status()).claudeCode.status).toBe('absent');
    expect((await hooks.status()).codebuddy.status).toBe('absent');
    expect(await hooks.apply('codebuddy', 'install')).toEqual({ ok: true });
    expect((await hooks.status()).codebuddy.status).toBe('installed');
    expect(await readFile(join(dir, '.codebuddy', 'settings.json'), 'utf8')).toContain(
      ' workbuddy ',
    );

    const data = join(dir, 'data');
    const result = spawnSync(
      process.execPath,
      [join(data, 'hooks', 'xinban-hook.cjs'), 'workbuddy', inboxPath(data)],
      {
        input: JSON.stringify({ session_id: 'wb1', hook_event_name: 'Stop', cwd: 'D:/w/app' }),
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(result.status).toBe(0);
    const [signal] = parseHookEvents(await readFile(inboxPath(data), 'utf8'));
    expect(signal).toMatchObject({ source: 'workbuddy', sessionId: 'wb1', kind: 'done' });

    expect(await hooks.apply('workbuddy', 'uninstall')).toEqual({ ok: true });
    const after = JSON.parse(await readFile(join(dir, '.workbuddy', 'settings.json'), 'utf8'));
    expect(after).toEqual(own);
  });

  it('creates Codex config when missing', async () => {
    const hooks = installer();
    expect(await hooks.apply('codex', 'install')).toEqual({ ok: true });
    expect((await hooks.status()).codex.status).toBe('installed');
  });

  it('the real hook script records state only, always exits 0, and feeds the inbox', async () => {
    const data = join(dir, 'data');
    await installer().apply('claude-code', 'install');
    const script = join(data, 'hooks', 'xinban-hook.cjs');
    const inbox = inboxPath(data);
    const run = (args: string[], input = '') =>
      spawnSync(process.execPath, [script, ...args], { input, encoding: 'utf8', timeout: 10_000 });

    const permission = run(
      ['claude', inbox],
      JSON.stringify({
        session_id: 'abc',
        hook_event_name: 'PermissionRequest',
        cwd: 'D:\\work\\shop-api',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf secret-stuff' },
        prompt: 'my private question',
      }),
    );
    expect(permission.status).toBe(0);
    expect(permission.stdout).toBe('');
    // 巨大的工具输出会被截断：仍要认出事件与会话。
    const huge = `{"session_id":"abc","hook_event_name":"PostToolUse","cwd":"D:/w","tool_response":"${'x'.repeat(400_000)}"}`;
    expect(run(['claude', inbox], huge).status).toBe(0);
    expect(run(['claude', inbox], 'garbage').status).toBe(0);
    expect(run(['bogus', inbox]).status).toBe(0);
    expect(
      run([
        'codex',
        inbox,
        JSON.stringify({
          type: 'agent-turn-complete',
          'thread-id': 't1',
          cwd: '/w',
          'last-assistant-message': 'secret answer',
        }),
      ]).status,
    ).toBe(0);

    const text = await readFile(inbox, 'utf8');
    expect(text).not.toContain('rm -rf');
    expect(text).not.toContain('private question');
    expect(text).not.toContain('secret answer');
    const records = text
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row) as Record<string, unknown>);
    expect(records.map((record) => record['ev'])).toEqual([
      'PermissionRequest',
      'PostToolUse',
      'agent-turn-complete',
    ]);
    expect(records[0]).toMatchObject({ v: 1, src: 'claude', sid: 'abc', tool: 'Bash' });

    // 收件箱 → ProgressService：没有任何日志来源时，会话也能靠钩子出现。
    const empty: ProgressSource = {
      list: async () => {
        throw new Error('no dir');
      },
      head: async () => '',
      tail: async () => '',
    };
    const now = Date.now();
    const service = new ProgressService(empty, () => now, new HookInbox(data));
    const state = await service.scan();
    expect(state.error).toBe('');
    expect(state.sessions.map((session) => [session.sessionId, session.signal])).toEqual(
      expect.arrayContaining([
        ['abc', 'working'],
        ['t1', 'done'],
      ]),
    );
  });
});
