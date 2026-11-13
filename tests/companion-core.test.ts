import { describe, expect, it } from 'vitest';
import { intentFor, type GestureContext } from '../src/core/gesture';
import { parseDue, toLocalInput } from '../src/core/due';
import {
  detectWorkNudges,
  dueTodoNudges,
  isWaitingTool,
  momentNudges,
} from '../src/core/nudge-sources';
import {
  bondPrompt,
  closenessOf,
  dayKey,
  daysBetween,
  emptyBond,
  normalizeBond,
  petLine,
  recordFocus,
  recordPet,
  recordTodoDone,
  touch,
  type BondState,
} from '../src/core/bond';
import {
  configure,
  defaultProactive,
  emptyProactive,
  expire,
  lineFor,
  normalizeProactive,
  offer,
  proactiveLimits,
  respond,
  type NudgeEvent,
  type ProactiveState,
} from '../src/core/proactive';
import {
  compactView,
  deviceProtocol,
  encodeHostFrame,
  LineBuffer,
  normalizeDeviceConfig,
  parseDeviceFrame,
  signalFor,
} from '../src/core/device-protocol';
import { buildDeviceView, dueLabel, type DeviceView } from '../src/core/device-view';
import { initialState, reduce } from '../src/core/state';
import { persistedSchema, type AppState } from '../src/core/schema';
import type { WorkProgressState, WorkSession } from '../src/core/progress';
import type { PendingConfirm } from '../src/core/confirm';
import { persistedState } from './fixtures';

const at = (y: number, m: number, d: number, h = 0, mi = 0): number =>
  new Date(y, m - 1, d, h, mi).getTime();

describe('gesture intents', () => {
  const idle: GestureContext = {
    confirmId: null,
    nudgeId: null,
    waitingTaskId: null,
    timerRecovery: false,
  };

  it('B long is always quiet, even over a confirm card', () => {
    expect(intentFor({ ...idle, confirmId: 'c1' }, 'B', 'long')).toEqual({ type: 'quiet-toggle' });
  });

  it('A long stays unassigned and never answers a card', () => {
    expect(intentFor({ ...idle, confirmId: 'c1' }, 'A', 'long').type).toBe('unassigned');
  });

  it('confirm beats nudge: A allows, B denies', () => {
    const ctx = { ...idle, confirmId: 'c1', nudgeId: 'n1' };
    expect(intentFor(ctx, 'A', 'short')).toEqual({ type: 'confirm-answer', id: 'c1', allow: true });
    expect(intentFor(ctx, 'B', 'short')).toEqual({
      type: 'confirm-answer',
      id: 'c1',
      allow: false,
    });
  });

  it('nudge beats sim task and game', () => {
    const ctx = { ...idle, nudgeId: 'n1', waitingTaskId: 't1' };
    expect(intentFor(ctx, 'A', 'short')).toEqual({ type: 'nudge-answer', id: 'n1', accept: true });
    expect(intentFor(ctx, 'B', 'short')).toEqual({ type: 'nudge-answer', id: 'n1', accept: false });
  });

  it('falls back to sim-ack, recovery hint, interact and game', () => {
    expect(intentFor({ ...idle, waitingTaskId: 't1' }, 'A', 'short')).toEqual({
      type: 'sim-ack',
      taskId: 't1',
    });
    expect(intentFor({ ...idle, timerRecovery: true }, 'A', 'short').type).toBe(
      'timer-recovery-hint',
    );
    expect(intentFor(idle, 'A', 'short').type).toBe('interact');
    expect(intentFor(idle, 'B', 'short').type).toBe('game-toggle');
  });
});

describe('parseDue', () => {
  const now = at(2026, 11, 9, 10, 0);

  it('parses datetime-local and rounds to the minute', () => {
    const result = parseDue('2026-11-10T15:00', now);
    expect(result).toEqual({ ok: true, at: at(2026, 11, 10, 15, 0) });
    expect(parseDue('2026-11-10 15:00:42', now)).toEqual({ ok: true, at: at(2026, 11, 10, 15, 0) });
  });

  it('fills a missing year with the current one', () => {
    expect(parseDue('11-10T08:30', now)).toEqual({ ok: true, at: at(2026, 11, 10, 8, 30) });
  });

  it('accepts explicit zones', () => {
    expect(parseDue('2026-11-10T07:00Z', now)).toEqual({
      ok: true,
      at: Date.UTC(2026, 10, 10, 7, 0),
    });
    expect(parseDue('2026-11-10T15:00+08:00', now)).toEqual({
      ok: true,
      at: Date.UTC(2026, 10, 10, 7, 0),
    });
  });

  it('rejects impossible dates, junk and out-of-range times', () => {
    expect(parseDue('2026-02-30T10:00', now).ok).toBe(false);
    expect(parseDue('tomorrow', now).ok).toBe(false);
    expect(parseDue('', now).ok).toBe(false);
    expect(parseDue('2026-11-07T10:00', now).ok).toBe(false);
    expect(parseDue('2028-11-10T10:00', now).ok).toBe(false);
  });

  it('allows a just-missed time (past day)', () => {
    expect(parseDue('2026-11-09T09:00', now).ok).toBe(true);
  });

  it('round-trips through toLocalInput', () => {
    expect(toLocalInput(at(2026, 1, 5, 7, 3))).toBe('2026-01-05T07:03');
  });
});

function session(patch: Partial<WorkSession>): WorkSession {
  return {
    sessionId: 's1',
    title: '修登录',
    project: 'app',
    cwd: 'D:/app',
    updatedAt: 1,
    status: 'working',
    runningTool: '',
    steps: [],
    stepCount: 0,
    lastUserText: '',
    lastAssistantText: '',
    ...patch,
  };
}
const progress = (...sessions: WorkSession[]): WorkProgressState => ({
  sessions,
  scannedAt: 0,
  error: '',
});

describe('nudge sources', () => {
  it('recognises waiting tools', () => {
    expect(isWaitingTool('AskUserQuestion')).toBe(true);
    expect(isWaitingTool('request_permission')).toBe(true);
    expect(isWaitingTool('read_file')).toBe(false);
  });

  it('reports a session that started waiting, once per tool change', () => {
    const before = progress(session({}));
    const after = progress(
      session({ runningTool: 'AskUserQuestion', updatedAt: 5, source: 'Claude Code' }),
    );
    const events = detectWorkNudges(before, after);
    expect(events).toEqual([
      { kind: 'agent-waiting', key: 'waiting:s1:5', subject: '修登录', source: 'Claude Code' },
    ]);
    expect(detectWorkNudges(after, after)).toEqual([]);
  });

  it('reports working → stopped only on the transition', () => {
    const stopped = progress(session({ status: 'resting', updatedAt: 9 }));
    expect(detectWorkNudges(progress(session({})), stopped)[0]?.kind).toBe('agent-stopped');
    expect(detectWorkNudges(progress(), stopped)).toEqual([]);
    expect(detectWorkNudges(stopped, stopped)).toEqual([]);
  });

  it('due todos: only open, due, and within 12 hours', () => {
    const now = at(2026, 11, 9, 12);
    const events = dueTodoNudges(
      [
        { id: 'a', title: '交报告', done: false, dueAt: now - 60_000 },
        { id: 'b', title: '已完成', done: true, dueAt: now - 60_000 },
        { id: 'c', title: '还没到', done: false, dueAt: now + 60_000 },
        { id: 'd', title: '太久了', done: false, dueAt: now - 13 * 3_600_000 },
        { id: 'e', title: '没时间', done: false },
      ],
      now,
    );
    expect(events.map((event) => event.subject)).toEqual(['交报告']);
  });

  it('maps bond moments to keyed events', () => {
    const events = momentNudges(
      [
        { kind: 'reunion', days: 4 },
        { kind: 'morning', streak: 2 },
      ],
      {
        day: '2026-11-09',
        openTodos: 3,
      },
    );
    expect(events).toEqual([
      { kind: 'reunion', key: 'reunion:2026-11-09', days: 4 },
      { kind: 'morning', key: 'morning:2026-11-09', streak: 2, todos: 3 },
    ]);
  });
});

describe('bond', () => {
  const first = at(2026, 11, 1, 14);

  it('counts days, streaks and reunions by calendar day', () => {
    let bond: BondState = emptyBond(first);
    bond = touch(bond, first).bond;
    expect(bond.daysTogether).toBe(1);
    bond = touch(bond, at(2026, 11, 2, 14)).bond;
    expect(bond.streak).toBe(2);
    const back = touch(bond, at(2026, 11, 6, 14));
    expect(back.bond.streak).toBe(1);
    expect(back.bond.longestStreak).toBe(2);
    expect(back.moments).toContainEqual({ kind: 'reunion', days: 4 });
  });

  it('says good morning once per day and skips it on a reunion', () => {
    let bond = touch(emptyBond(first), first).bond;
    const morning = touch(bond, at(2026, 11, 2, 8));
    expect(morning.moments).toContainEqual({ kind: 'morning', streak: 2 });
    bond = morning.bond;
    expect(touch(bond, at(2026, 11, 2, 9)).moments).toEqual([]);
    const reunion = touch(bond, at(2026, 11, 8, 8));
    expect(reunion.moments.map((moment) => moment.kind)).toEqual(['reunion']);
  });

  it('only wraps up an evening that had something in it', () => {
    const bond = touch(emptyBond(first), first).bond;
    expect(touch(bond, at(2026, 11, 1, 20)).moments).toEqual([]);
    const busy = recordTodoDone(touch(emptyBond(first), first).bond, first).bond;
    expect(touch(busy, at(2026, 11, 1, 20)).moments[0]?.kind).toBe('evening');
  });

  it('hits the 7-day milestone exactly once', () => {
    let bond = touch(emptyBond(first), first).bond;
    const kinds: string[] = [];
    for (let day = 2; day <= 9; day += 1) {
      const result = touch(bond, at(2026, 11, day, 14));
      bond = result.bond;
      kinds.push(...result.moments.filter((m) => m.kind === 'milestone').map(() => `d${day}`));
    }
    expect(kinds).toEqual(['d7']);
  });

  it('todo milestones and today ledger roll over at midnight', () => {
    let bond = touch(emptyBond(first), first).bond;
    let milestone = false;
    for (let index = 0; index < 10; index += 1) {
      const result = recordTodoDone(bond, first);
      bond = result.bond;
      milestone ||= result.moments.some((m) => m.kind === 'milestone' && m.todos === 10);
    }
    expect(milestone).toBe(true);
    expect(bond.today.todosDone).toBe(10);
    bond = recordFocus(bond, 25, at(2026, 11, 2, 9));
    expect(bond.today).toMatchObject({ day: '2026-11-02', todosDone: 0, focusMinutes: 25 });
    expect(bond.todosDone).toBe(10);
  });

  it('pet reactions get grumpy on a burst', () => {
    const bond = recordPet(emptyBond(first), first);
    expect(closenessOf(bond)).toBe('new');
    const calm = petLine(bond, [first], first);
    const burst = petLine(bond, [first, first, first, first, first], first);
    expect(calm).not.toBe(burst);
  });

  it('prompt is empty on day one and factual later, without gendered pronouns', () => {
    const one = touch(emptyBond(first), first).bond;
    expect(bondPrompt(one, first)).toBe('');
    const two = recordTodoDone(touch(one, at(2026, 11, 2, 14)).bond, at(2026, 11, 2, 15)).bond;
    const text = bondPrompt(two, at(2026, 11, 2, 15));
    expect(text).toContain('第 2 天');
    expect(text).not.toMatch(/[他她]/);
  });

  it('normalizes a damaged file without losing good fields', () => {
    const bond = normalizeBond(
      { pets: 12, streak: -3, milestones: ['day-7', 5], today: 'x' },
      first,
    );
    expect(bond.pets).toBe(12);
    expect(bond.streak).toBe(0);
    expect(bond.milestones).toEqual(['day-7']);
    expect(bond.today.day).toBe(dayKey(first));
  });

  it('daysBetween uses calendar days', () => {
    expect(daysBetween('2026-10-31', '2026-11-01')).toBe(1);
    expect(daysBetween('', '2026-11-01')).toBe(0);
  });
});

describe('proactive nudges', () => {
  const now = at(2026, 11, 9, 10);
  let sequence = 0;
  const ctx = (time = now) => ({ now: time, id: `n${(sequence += 1)}`, preset: 'banter' as const });
  const stop = (key: string): NudgeEvent => ({
    kind: 'agent-stopped',
    key,
    subject: '修登录',
    source: 'Codex',
  });

  it('shows the first nudge and never repeats the same key', () => {
    const first = offer(emptyProactive(), stop('k1'), ctx());
    expect(first.accepted).toBe(true);
    expect(first.state.current?.key).toBe('k1');
    expect(first.state.current?.askPrompt).toContain('Codex');
    const again = offer(first.state, stop('k1'), ctx());
    expect(again).toMatchObject({ accepted: false, reason: 'seen' });
  });

  it('enforces per-kind cooldown, doubled after a dismiss', () => {
    let state = offer(emptyProactive(), stop('k1'), ctx()).state;
    const id = state.current!.id;
    state = respond(state, id, 'dismiss', now).state;
    expect(state.penalty['agent-stopped']).toBe(2);
    const soon = offer(state, stop('k2'), ctx(now + proactiveLimits.cooldownMs + 1));
    expect(soon).toMatchObject({ accepted: false, reason: 'cooldown' });
    const later = offer(state, stop('k3'), ctx(now + 2 * proactiveLimits.cooldownMs + 1));
    expect(later.accepted).toBe(true);
  });

  it('urgent kinds bypass cooldown and budget, and jump the queue', () => {
    let state: ProactiveState = emptyProactive();
    const kinds = ['agent-stopped', 'delegate-done', 'milestone', 'reunion'] as const;
    kinds.forEach((kind, index) => {
      state = offer(state, { kind, key: `x${index}` }, ctx()).state;
    });
    // 预算 4：第五个普通的被挡
    expect(offer(state, { kind: 'morning', key: 'm' }, ctx())).toMatchObject({ accepted: false });
    const urgent = offer(state, { kind: 'todo-due', key: 'due', subject: '交报告' }, ctx());
    expect(urgent.accepted).toBe(true);
    expect(urgent.state.queue[0]?.kind).toBe('todo-due');
  });

  it('queue holds at most 3', () => {
    let state: ProactiveState = emptyProactive();
    for (let index = 0; index < 4; index += 1) {
      state = offer(state, { kind: 'todo-due', key: `d${index}` }, ctx()).state;
    }
    expect(state.queue).toHaveLength(3);
    expect(offer(state, { kind: 'todo-due', key: 'd9' }, ctx())).toMatchObject({
      reason: 'queue-full',
    });
  });

  it('expires an unanswered card and promotes the next one', () => {
    let state = offer(emptyProactive(), { kind: 'todo-due', key: 'a' }, ctx()).state;
    state = offer(state, { kind: 'timer-done', key: 'b' }, ctx()).state;
    state = expire(state, now + proactiveLimits.showMs + 1);
    expect(state.history[0]?.outcome).toBe('expired');
    expect(state.current?.key).toBe('b');
  });

  it('turning a group off clears its cards and refills from the queue on tick', () => {
    let state = offer(emptyProactive(), { kind: 'todo-due', key: 'a' }, ctx()).state;
    state = offer(state, { kind: 'agent-waiting', key: 'w' }, ctx()).state;
    // agent-waiting 在队里，当前是 todo-due
    state = configure(state, {
      ...defaultProactive,
      groups: { work: true, reminder: false, ritual: true },
    });
    expect(state.current).toBeNull();
    state = expire(state, now + 1);
    expect(state.current?.kind).toBe('agent-waiting');
    expect(offer(state, { kind: 'todo-due', key: 'z' }, ctx())).toMatchObject({
      reason: 'group-off',
    });
  });

  it('disabled means silent', () => {
    const state = configure(emptyProactive(), { ...defaultProactive, enabled: false });
    expect(offer(state, stop('k'), ctx())).toMatchObject({ accepted: false, reason: 'disabled' });
  });

  it('picks lines deterministically per key and preset', () => {
    const event = stop('same');
    expect(lineFor(event, 'dry')).toBe(lineFor(event, 'dry'));
    expect(lineFor(event, 'dry')).toBe('Codex停了。');
    expect(lineFor({ kind: 'agent-stopped', key: 'x' }, 'warm', '阿强')).not.toContain('阿强');
  });

  it('normalizes config leniently', () => {
    expect(normalizeProactive(null)).toEqual(defaultProactive);
    expect(normalizeProactive({ enabled: false, groups: { ritual: false } })).toEqual({
      enabled: false,
      speak: false,
      groups: { work: true, reminder: true, ritual: false },
    });
  });
});

function baseState(now: number): AppState {
  return { ...initialState(now), now };
}

describe('device view', () => {
  const now = at(2026, 11, 9, 10);

  it('dueLabel', () => {
    expect(dueLabel(undefined, now)).toBe('');
    expect(dueLabel(now - 1, now)).toBe('已到点');
    expect(dueLabel(at(2026, 11, 9, 15, 5), now)).toBe('今天 15:05');
    expect(dueLabel(at(2026, 11, 12, 8, 0), now)).toBe('11/12 08:00');
  });

  it('puts the soonest-due todo on screen and confirm cards first', () => {
    let state = baseState(now);
    state = reduce(state, { type: 'todo.add', title: '没期限' }, { now, id: 't1' });
    state = reduce(
      state,
      { type: 'todo.add', title: '下午交', dueAt: at(2026, 11, 9, 15) },
      { now, id: 't2' },
    );
    const pending: PendingConfirm = {
      id: 'c1',
      tool: 'run_command',
      title: '要跑一条命令',
      detail: 'npm test',
      createdAt: now,
      expiresAt: now + 30_000,
    };
    const view = buildDeviceView({ state, confirm: pending, nudge: null });
    expect(view.todo).toEqual({ title: '下午交', more: 1, due: '今天 15:00' });
    expect(view.card).toMatchObject({ kind: 'confirm', seconds: 30, hintA: '允许', hintB: '拒绝' });
    expect(view.mood).toBe('waiting');
    expect(signalFor(view)).toBe('confirm');
  });

  it('quiet mode silences signals', () => {
    const state = { ...baseState(now), settings: { ...baseState(now).settings, quiet: true } };
    const view = buildDeviceView({ state, confirm: null, nudge: null });
    expect(view.corner).toBe('勿扰');
    expect(signalFor(view)).toBe('none');
  });
});

describe('todo due reducer and schema', () => {
  const now = at(2026, 11, 9, 10);

  it('sets and clears dueAt', () => {
    let state = reduce(baseState(now), { type: 'todo.add', title: '写周报' }, { now, id: 't1' });
    state = reduce(
      state,
      { type: 'todo.due', id: 't1', dueAt: at(2026, 11, 9, 18) },
      { now, id: 'x' },
    );
    expect(state.todos[0]?.dueAt).toBe(at(2026, 11, 9, 18));
    state = reduce(state, { type: 'todo.due', id: 't1', dueAt: null }, { now, id: 'y' });
    expect(state.todos[0]?.dueAt).toBeUndefined();
  });

  it('rejects persisted state with duplicate todo ids', () => {
    const todo = { id: 't1', title: 'a', done: false, createdAt: now };
    expect(persistedSchema.safeParse(persistedState({ todos: [todo, todo] })).success).toBe(false);
    expect(persistedSchema.safeParse(persistedState({ todos: [todo] })).success).toBe(true);
  });
});

describe('device protocol', () => {
  it('parses valid frames and drops junk', () => {
    expect(parseDeviceFrame('{"t":"btn","b":"A","e":"down","ms":12}')).toEqual({
      t: 'btn',
      b: 'A',
      e: 'down',
      ms: 12,
    });
    expect(parseDeviceFrame('{"t":"hello","proto":1,"fw":"1.0","extra":true}')).toMatchObject({
      t: 'hello',
    });
    expect(parseDeviceFrame('{"t":"btn","b":"C","e":"down","ms":1}')).toBeNull();
    expect(parseDeviceFrame('not json')).toBeNull();
    expect(parseDeviceFrame('{broken')).toBeNull();
    expect(parseDeviceFrame(`{"t":"log","msg":"${'x'.repeat(3000)}"}`)).toBeNull();
  });

  it('splits lines across arbitrary chunk boundaries and drops runaway lines', () => {
    const buffer = new LineBuffer();
    expect(buffer.push('{"t":"po')).toEqual([]);
    expect(buffer.push('ng","n":1}\r\n{"t"')).toEqual(['{"t":"pong","n":1}']);
    buffer.push('x'.repeat(deviceProtocol.maxFrameBytes * 2 + 10));
    expect(buffer.push('\n')).toEqual([]);
  });

  it('keeps every view frame under the byte limit, even with long Chinese text', () => {
    const now = at(2026, 11, 9, 10);
    const long = '很长的中文'.repeat(400);
    const view: DeviceView = {
      ...buildDeviceView({ state: baseState(now), confirm: null, nudge: null }),
      title: long,
      detail: long,
      bubble: long,
      work: long,
    };
    const line = encodeHostFrame({ t: 'view', view });
    expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(deviceProtocol.maxFrameBytes);
    expect(line.endsWith('\n')).toBe(true);
    expect(compactView(view).title.length).toBeLessThan(long.length);
  });

  it('only accepts port-like names', () => {
    expect(normalizeDeviceConfig({ enabled: true, mode: 'serial', port: 'COM5' }).port).toBe(
      'COM5',
    );
    expect(normalizeDeviceConfig({ port: '/dev/ttyACM0' }).port).toBe('/dev/ttyACM0');
    expect(normalizeDeviceConfig({ port: '..\\..\\evil' }).port).toBe('');
    expect(normalizeDeviceConfig({ mode: 'wifi' }).mode).toBe('serial');
  });
});
