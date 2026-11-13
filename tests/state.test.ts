import { describe, expect, it } from 'vitest';
import type { AppState, InternalAction, Timer } from '../src/core/schema';
import {
  displayState,
  durableState,
  formatClock,
  formatDuration,
  initialState,
  reduce,
  remainingMs,
  restoreState,
} from '../src/core/state';
import { persistedState, simulationEvent } from './fixtures';

const START = 100_000;

function apply(state: AppState, action: InternalAction, now = state.now, id = 'injected-id') {
  return reduce(state, action, { now, id });
}

function startTimer(minutes = 1) {
  return apply(initialState(START), { type: 'timer.start', minutes }, START, 'timer-1');
}

describe('timer transitions', () => {
  it('starts with injected time and id without mutating the previous state', () => {
    const before = initialState(START);
    const next = apply(before, { type: 'timer.start', minutes: 2 }, START, 'timer-2');
    expect(next.timer).toEqual({
      id: 'timer-2',
      status: 'running',
      durationMs: 120_000,
      remainingMs: 120_000,
      startedAt: START,
    });
    expect(next.revision).toBe(1);
    expect(before).toEqual(initialState(START));
  });

  it('pauses precisely, freezes during the pause, and resumes only the remaining interval', () => {
    const running = startTimer(2);
    const paused = apply(running, { type: 'timer.pause' }, START + 25_000);
    expect(paused.timer).toEqual({
      ...running.timer,
      status: 'paused',
      remainingMs: 95_000,
      startedAt: null,
    });
    expect(remainingMs(running.timer, START + 25_000)).toBe(95_000);
    const later = apply(paused, { type: 'clock.tick' }, START + 300_000);
    expect(later.timer).toEqual(paused.timer);
    expect(remainingMs(later.timer, START + 500_000)).toBe(95_000);

    const resumed = apply(later, { type: 'timer.resume' }, START + 300_000);
    expect(resumed.timer).toEqual({
      ...paused.timer,
      status: 'running',
      startedAt: START + 300_000,
    });
    const secondPause = apply(resumed, { type: 'timer.pause' }, START + 310_000);
    expect(secondPause.timer?.remainingMs).toBe(85_000);
    const secondResume = apply(secondPause, { type: 'timer.resume' }, START + 400_000);
    const almost = apply(secondResume, { type: 'clock.tick' }, START + 484_999);
    expect(almost.timer?.status).toBe('running');
    expect(remainingMs(almost.timer, almost.now)).toBe(1);
    const completed = apply(almost, { type: 'clock.tick' }, START + 485_000);
    expect(completed.timer).toEqual({
      id: 'timer-1',
      status: 'completed',
      durationMs: 120_000,
      remainingMs: 0,
      startedAt: null,
    });
    expect(apply(completed, { type: 'clock.tick' }, START + 900_000).timer).toEqual(
      completed.timer,
    );
    expect(running.timer?.remainingMs).toBe(120_000);
  });

  it.each<InternalAction>([
    { type: 'clock.tick' },
    { type: 'timer.pause' },
    { type: 'timer.resume' },
    { type: 'pet.interact' },
    { type: 'todo.add', title: 'Still pending' },
    { type: 'sim.event', event: simulationEvent() },
  ])('settles expiry before processing $type', (action) => {
    const next = apply(startTimer(), action, START + 60_000);
    expect(next.timer).toMatchObject({ status: 'completed', remainingMs: 0, startedAt: null });
  });

  it('clamps backward time and never increases the remaining duration', () => {
    const running = apply(startTimer(), { type: 'clock.tick' }, START + 20_000);
    const paused = apply(running, { type: 'timer.pause' }, START - 5_000);
    expect(paused.now).toBe(START + 20_000);
    expect(paused.timer?.remainingMs).toBe(40_000);
    const resumed = apply(paused, { type: 'timer.resume' }, START);
    expect(resumed.timer?.startedAt).toBe(START + 20_000);
    expect(remainingMs(startTimer().timer, START - 10_000)).toBe(60_000);
    expect(remainingMs(startTimer().timer, START + 500_000)).toBe(0);
    expect(remainingMs(null, START)).toBe(0);
  });

  it.each(['running', 'paused', 'recovery'] as const)(
    'rejects replacing a %s timer without cancelling it',
    (status) => {
      const state = startTimer();
      const timer = state.timer!;
      state.timer = { ...timer, status, startedAt: status === 'running' ? START : null };
      expect(() => apply(state, { type: 'timer.start', minutes: 5 })).toThrow('请先结束当前计时');
      expect(state.timer).toEqual({
        ...timer,
        status,
        startedAt: status === 'running' ? START : null,
      });
    },
  );

  it('can replace a timer that has just expired, using the new id', () => {
    const next = apply(
      startTimer(),
      { type: 'timer.start', minutes: 2 },
      START + 60_000,
      'timer-2',
    );
    expect(next.timer).toEqual({
      id: 'timer-2',
      status: 'running',
      durationMs: 120_000,
      remainingMs: 120_000,
      startedAt: START + 60_000,
    });
  });

  it('cancels a timer without implying task completion', () => {
    const state = apply(startTimer(), { type: 'todo.add', title: 'Unfinished' });
    const cancelled = apply(state, { type: 'timer.cancel' }, START + 30_000);
    expect(cancelled.timer).toBeNull();
    expect(cancelled.todos).toEqual(state.todos);
    expect(displayState(cancelled).mood).toBe('idle');
  });

  it('makes pause/resume safe no-ops when no eligible timer exists', () => {
    const empty = initialState(START);
    expect(apply(empty, { type: 'timer.pause' }).timer).toBeNull();
    expect(apply(empty, { type: 'timer.resume' }).timer).toBeNull();
    const running = startTimer();
    expect(apply(running, { type: 'timer.resume' }, START + 1_000).timer).toEqual(running.timer);
    const paused = apply(running, { type: 'timer.pause' }, START + 1_000);
    expect(apply(paused, { type: 'timer.pause' }, START + 10_000).timer).toEqual(paused.timer);
    const completed = apply(running, { type: 'clock.tick' }, START + 60_000);
    expect(apply(completed, { type: 'timer.resume' }).timer).toEqual(completed.timer);
  });
});

describe('timer recovery', () => {
  it('turns a running timer into a clock-jump recovery instead of silently guessing', () => {
    const running = startTimer(2);
    const jumped = apply(
      running,
      { type: 'timer.clock-jump', jumpMs: 30 * 60_000 },
      START + 20_000,
    );
    expect(jumped.timer).toMatchObject({
      status: 'recovery',
      recoveryReason: 'clock-jump',
      remainingMs: 100_000,
      startedAt: null,
    });
    expect(displayState(jumped).mood).toBe('waiting');
    // 待确认期间不再走表，不会因为墙钟前进而自己扣完。
    const later = apply(jumped, { type: 'clock.tick' }, START + 3_600_000);
    expect(later.timer).toEqual(jumped.timer);
    const resumed = apply(later, { type: 'timer.resume' }, START + 3_600_000);
    expect(resumed.timer).toMatchObject({ status: 'running', startedAt: START + 3_600_000 });
    expect(resumed.timer?.recoveryReason).toBeUndefined();
  });

  it('a clock jump that makes the timer look elapsed still goes to recovery, not completed', () => {
    const running = startTimer(2);
    const jumped = apply(
      running,
      { type: 'timer.clock-jump', jumpMs: 30 * 60_000 },
      START + 30 * 60_000,
    );
    expect(jumped.timer).toMatchObject({
      status: 'recovery',
      recoveryReason: 'clock-jump',
      remainingMs: 0,
    });
    const resumed = apply(jumped, { type: 'timer.resume' }, START + 30 * 60_000);
    expect(resumed.timer?.status).toBe('completed');
  });

  it('ignores a clock jump when no timer is running', () => {
    const idle = apply(
      initialState(START),
      { type: 'timer.clock-jump', jumpMs: 60_000 },
      START + 1_000,
    );
    expect(idle.timer).toBeNull();
    const paused = apply(startTimer(), { type: 'timer.pause' }, START + 5_000);
    const after = apply(paused, { type: 'timer.clock-jump', jumpMs: 60_000 }, START + 6_000);
    expect(after.timer).toEqual(paused.timer);
  });

  it('requires explicit resume after restart and does not count time spent in recovery', () => {
    const saved = durableState(startTimer(2));
    const original = structuredClone(saved);
    const restored = restoreState(saved, START + 30_000);
    expect(restored.timer).toEqual({
      id: 'timer-1',
      status: 'recovery',
      durationMs: 120_000,
      remainingMs: 90_000,
      startedAt: null,
      recoveryReason: 'restart',
    });
    expect(restored.now).toBe(START + 30_000);
    expect(restored.revision).toBe(0);
    expect(displayState(restored)).toMatchObject({ mood: 'waiting', simulated: false });
    const waited = apply(restored, { type: 'clock.tick' }, START + 900_000);
    expect(waited.timer).toEqual(restored.timer);
    const relaunched = restoreState(durableState(waited), START + 1_000_000);
    expect(relaunched.timer).toEqual(restored.timer);
    const resumed = apply(relaunched, { type: 'timer.resume' });
    expect(resumed.timer).toMatchObject({
      status: 'running',
      remainingMs: 90_000,
      startedAt: START + 1_000_000,
    });
    expect(saved).toEqual(original);
  });

  it('requires acknowledgement even if a running timer expired while the app was closed', () => {
    const restored = restoreState(durableState(startTimer()), START + 600_000);
    expect(restored.timer).toMatchObject({ status: 'recovery', remainingMs: 0, startedAt: null });
    expect(displayState(restored).mood).toBe('waiting');
    const acknowledged = apply(restored, { type: 'timer.resume' });
    expect(acknowledged.timer).toMatchObject({
      status: 'completed',
      remainingMs: 0,
      startedAt: null,
    });
  });

  it('does not add time when the restart clock is earlier than the saved start', () => {
    const restored = restoreState(durableState(startTimer()), START - 10_000);
    expect(restored.timer).toMatchObject({ status: 'recovery', remainingMs: 60_000 });
  });

  it.each(['paused', 'recovery', 'completed'] as const)(
    'preserves a persisted %s timer without running it',
    (status) => {
      const timer: Timer = {
        id: 'timer-1',
        status,
        durationMs: 60_000,
        remainingMs: status === 'completed' ? 0 : 30_000,
        startedAt: null,
      };
      expect(restoreState(persistedState({ timer }), START + 900_000).timer).toEqual(timer);
    },
  );

  it('validates restored data rather than accepting transient or invalid fields', () => {
    expect(() => restoreState({ ...persistedState(), version: 2 }, START)).toThrow();
    expect(() => restoreState(initialState(START), START)).toThrow();
    expect(() =>
      restoreState({ ...persistedState(), timer: { status: 'running' } }, START),
    ).toThrow();
  });
});

describe('simulation event ordering', () => {
  it('ignores a duplicate event id even if its payload and sequence change', () => {
    const first = apply(initialState(START), { type: 'sim.event', event: simulationEvent() });
    const duplicate = apply(
      first,
      {
        type: 'sim.event',
        event: simulationEvent({ sequence: 10, status: 'succeeded', title: 'Forged retry' }),
      },
      START + 1_000,
    );
    expect(duplicate.simulation.tasks).toEqual(first.simulation.tasks);
    expect(duplicate.simulation.seenIds).toEqual(['event-1']);
    expect(duplicate.simulation.journal[0]).toContain('重复');
  });

  it.each([0, 4, 5])(
    'ignores an old or equal sequence %s without losing the newer state',
    (sequence) => {
      const first = apply(initialState(START), {
        type: 'sim.event',
        event: simulationEvent({ sequence: 5, progress: { completed: 3, total: 5 } }),
      });
      const staleEvent = simulationEvent({ eventId: 'old-event', sequence, status: 'failed' });
      const stale = apply(first, { type: 'sim.event', event: staleEvent }, START + 1_000);
      expect(stale.simulation.tasks).toEqual(first.simulation.tasks);
      expect(stale.simulation.seenIds).toEqual(['event-1', 'old-event']);
      expect(stale.simulation.journal[0]).toContain('过期');
      expect(
        apply(stale, { type: 'sim.event', event: staleEvent }).simulation.journal[0],
      ).toContain('重复');
    },
  );

  it('accepts a newer event for the same task without creating duplicate tasks', () => {
    const first = apply(initialState(START), { type: 'sim.event', event: simulationEvent() });
    const event = simulationEvent({ eventId: 'event-2', sequence: 1, status: 'waiting' });
    const updated = apply(first, { type: 'sim.event', event }, START + 50);
    expect(updated.simulation.tasks).toEqual([
      { id: 'task-1', title: 'Run tests', sequence: 1, status: 'waiting', updatedAt: START + 50 },
    ]);
    expect(first.simulation.tasks[0]?.status).toBe('running');
  });

  it.each(['succeeded', 'failed', 'cancelled'] as const)(
    'makes %s terminal even for higher-sequence updates',
    (status) => {
      const terminal = apply(initialState(START), {
        type: 'sim.event',
        event: simulationEvent({ status, sequence: 5 }),
      });
      let state = terminal;
      const updates = ['running', 'waiting', 'succeeded', 'failed', 'cancelled'] as const;
      for (const [index, nextStatus] of updates.entries()) {
        state = apply(
          state,
          {
            type: 'sim.event',
            event: simulationEvent({
              eventId: `late-${index}`,
              sequence: 6 + index,
              status: nextStatus,
            }),
          },
          START + 1_000 + index,
        );
        expect(state.simulation.tasks).toEqual(terminal.simulation.tasks);
        expect(state.simulation.journal[0]).toContain('终态');
      }
      const retried = apply(state, {
        type: 'sim.event',
        event: simulationEvent({ eventId: 'retry-event', taskId: 'retry-task' }),
      });
      expect(retried.simulation.tasks).toHaveLength(2);
      expect(retried.simulation.tasks[0]).toMatchObject({ id: 'retry-task', status: 'running' });
    },
  );

  it('drops offline events and does not redisplay stale tasks after reconnect', () => {
    const first = apply(initialState(START), { type: 'sim.event', event: simulationEvent() });
    const offline = apply(first, { type: 'sim.connect', connected: false });
    const event = simulationEvent({ eventId: 'event-2', sequence: 1, status: 'succeeded' });
    const dropped = apply(offline, { type: 'sim.event', event });
    expect(dropped.simulation.tasks).toEqual(first.simulation.tasks);
    expect(dropped.simulation.seenIds).toEqual(['event-1']);
    expect(displayState(dropped)).toMatchObject({ mood: 'sleep', simulated: true });
    expect(displayState(dropped).detail).toContain('待确认');
    const connected = apply(dropped, { type: 'sim.connect', connected: true });
    expect(connected.simulation.tasks).toEqual([]);
    expect(connected.simulation.seenIds).toEqual(dropped.simulation.seenIds);
    expect(connected.simulation.journal.slice(1)).toEqual(dropped.simulation.journal);
    expect(displayState(connected)).toMatchObject({ mood: 'idle', simulated: false });
    expect(apply(connected, { type: 'sim.event', event }).simulation.tasks[0]?.status).toBe(
      'succeeded',
    );
  });

  it('retains deduplication across reconnect and only clears tasks on a false-to-true transition', () => {
    const event = simulationEvent();
    const first = apply(initialState(START), { type: 'sim.event', event });
    const stillConnected = apply(first, { type: 'sim.connect', connected: true });
    expect(stillConnected.simulation.tasks).toEqual(first.simulation.tasks);
    const disconnected = apply(stillConnected, { type: 'sim.connect', connected: false });
    const stillDisconnected = apply(disconnected, { type: 'sim.connect', connected: false });
    expect(stillDisconnected.simulation.tasks).toEqual(first.simulation.tasks);
    const reconnected = apply(stillDisconnected, { type: 'sim.connect', connected: true });
    const duplicate = apply(reconnected, { type: 'sim.event', event });
    expect(duplicate.simulation.tasks).toEqual([]);
    expect(duplicate.simulation.seenIds).toEqual(['event-1']);
    expect(duplicate.simulation.journal[0]).toContain('重复');
    const fresh = apply(duplicate, {
      type: 'sim.event',
      event: simulationEvent({ eventId: 'fresh-event', taskId: 'fresh-task' }),
    });
    expect(fresh.simulation.tasks).toHaveLength(1);
    expect(fresh.simulation.tasks[0]?.id).toBe('fresh-task');
  });

  it('bounds task, deduplication and journal history', () => {
    let state = initialState(START);
    for (let index = 0; index < 520; index += 1) {
      state = apply(state, {
        type: 'sim.event',
        event: simulationEvent({ eventId: `event-${index}`, taskId: `task-${index}` }),
      });
    }
    expect(state.simulation.tasks).toHaveLength(30);
    expect(state.simulation.tasks[0]?.id).toBe('task-519');
    expect(state.simulation.tasks.at(-1)?.id).toBe('task-490');
    expect(state.simulation.seenIds).toHaveLength(512);
    expect(state.simulation.seenIds[0]).toBe('event-8');
    expect(state.simulation.journal).toHaveLength(40);
  });
});

describe('honest progress and display', () => {
  it('never invents progress or task success from elapsed time', () => {
    const first = apply(initialState(START), { type: 'sim.event', event: simulationEvent() });
    const later = apply(first, { type: 'clock.tick' }, START + 86_400_000);
    expect(later.simulation.tasks).toEqual(first.simulation.tasks);
    expect(later.simulation.tasks[0]?.progress).toBeUndefined();
    expect(displayState(later)).toEqual({
      mood: 'busy',
      title: '正在进行中',
      detail: 'Run tests',
      simulated: true,
    });
  });

  it('shows only explicit counts and does not equate a full count with a success event', () => {
    const state = apply(initialState(START), {
      type: 'sim.event',
      event: simulationEvent({ progress: { completed: 10, total: 10 } }),
    });
    expect(displayState(state)).toMatchObject({
      mood: 'busy',
      detail: 'Run tests · 10/10',
      simulated: true,
    });
    expect(state.simulation.tasks[0]?.status).toBe('running');
    const next = apply(state, {
      type: 'sim.event',
      event: simulationEvent({ eventId: 'event-2', sequence: 1 }),
    });
    expect(next.simulation.tasks[0]?.progress).toBeUndefined();
    expect(displayState(next).detail).toBe('Run tests');
  });

  it('timer expiry does not finish todos or simulated tasks', () => {
    let state = apply(startTimer(), { type: 'todo.add', title: 'Not finished' });
    state = apply(state, { type: 'sim.event', event: simulationEvent() });
    const completed = apply(state, { type: 'clock.tick' }, START + 60_000);
    expect(completed.todos[0]?.done).toBe(false);
    expect(completed.simulation.tasks[0]?.status).toBe('running');
    expect(displayState(completed)).toMatchObject({
      mood: 'happy',
      detail: '计时结束不代表任务完成',
      simulated: false,
    });
  });

  it.each(['succeeded', 'failed'] as const)(
    'expires the transient %s display after eight seconds',
    (status) => {
      const state = apply(initialState(START), {
        type: 'sim.event',
        event: simulationEvent({ status }),
      });
      const mood = status === 'succeeded' ? 'happy' : 'sad';
      expect(displayState(apply(state, { type: 'clock.tick' }, START + 7_999))).toMatchObject({
        mood,
        simulated: true,
      });
      const expired = apply(state, { type: 'clock.tick' }, START + 8_000);
      expect(displayState(expired)).toMatchObject({ mood: 'idle', simulated: false });
      expect(expired.simulation.tasks[0]?.status).toBe(status);
    },
  );

  it('gives waiting events precedence over running, success and timer-completion displays', () => {
    let state = apply(startTimer(), { type: 'clock.tick' }, START + 60_000);
    state = apply(state, { type: 'sim.event', event: simulationEvent({ status: 'waiting' }) });
    state = apply(state, {
      type: 'sim.event',
      event: simulationEvent({ eventId: 'event-2', taskId: 'task-2', status: 'succeeded' }),
    });
    expect(displayState(state)).toMatchObject({
      mood: 'waiting',
      detail: 'Run tests',
      simulated: true,
    });
  });
});

describe('local state and durable isolation', () => {
  it('creates independent initial states with the exact durable defaults', () => {
    const first = initialState(START);
    expect(durableState(first)).toEqual(persistedState());
    first.todos.push({ id: 'local', title: 'Local', done: false, createdAt: START });
    first.settings.quiet = true;
    first.simulation.seenIds.push('local-event');
    expect(durableState(initialState(START))).toEqual(persistedState());
    expect(initialState(START).simulation.seenIds).toEqual([]);
  });

  it('excludes every transient field from persistence and resets them on restore', () => {
    let state = apply(initialState(START), { type: 'todo.add', title: 'Keep me' }, START, 'todo-1');
    state = apply(state, { type: 'settings.patch', patch: { quiet: true } });
    state = apply(state, { type: 'session.set', kind: 'design', title: 'Keep session' });
    state = apply(state, { type: 'pet.interact' });
    state = apply(state, { type: 'sim.event', event: simulationEvent() });
    state = apply(state, { type: 'sim.connect', connected: false });
    const saved = durableState(state);
    expect(Object.keys(saved).sort()).toEqual(['session', 'settings', 'timer', 'todos', 'version']);
    const restored = restoreState(JSON.parse(JSON.stringify(saved)), START + 1_000);
    expect(durableState(restored)).toEqual(saved);
    expect(restored.simulation).toEqual(initialState(START).simulation);
    expect(restored.petUntil).toBe(0);
    expect(restored.revision).toBe(0);
    const reset = apply(state, { type: 'sim.reset' });
    expect(reset.simulation).toEqual(initialState(START).simulation);
    expect(durableState(reset)).toEqual(saved);
  });

  it('adds, toggles and removes todos immutably using the injected id and time', () => {
    const first = apply(initialState(START), { type: 'todo.add', title: 'First' }, START, 'todo-1');
    const second = apply(first, { type: 'todo.add', title: 'Second' }, START + 1, 'todo-2');
    expect(second.todos).toEqual([
      { id: 'todo-2', title: 'Second', done: false, createdAt: START + 1 },
      { id: 'todo-1', title: 'First', done: false, createdAt: START },
    ]);
    const toggled = apply(second, { type: 'todo.toggle', id: 'todo-1' });
    expect(toggled.todos[1]?.done).toBe(true);
    expect(second.todos[1]?.done).toBe(false);
    expect(apply(toggled, { type: 'todo.toggle', id: 'todo-1' }).todos).toEqual(second.todos);
    expect(apply(toggled, { type: 'todo.remove', id: 'todo-1' }).todos).toEqual([second.todos[0]]);
    expect(apply(second, { type: 'todo.toggle', id: 'missing' }).todos).toEqual(second.todos);
    expect(apply(second, { type: 'todo.remove', id: 'missing' }).todos).toEqual(second.todos);
    expect(first.todos).toHaveLength(1);
  });

  it('rejects the 1,001st todo instead of silently dropping an existing record', () => {
    const state = initialState(START);
    state.todos = Array.from({ length: 1_000 }, (_, index) => ({
      id: `todo-${index}`,
      title: 'Existing',
      done: false,
      createdAt: START,
    }));
    expect(() => apply(state, { type: 'todo.add', title: 'Overflow' })).toThrow('1000');
    expect(state.todos).toHaveLength(1_000);
  });

  it('merges settings and limits pet feedback to four seconds', () => {
    const state = apply(initialState(START), { type: 'settings.patch', patch: { quiet: true } });
    expect(state.settings).toEqual({ alwaysOnTop: false, quiet: true, reducedMotion: false });
    const petted = apply(state, { type: 'pet.interact' });
    expect(petted.petUntil).toBe(START + 4_000);
    expect(displayState(apply(petted, { type: 'clock.tick' }, START + 3_999))).toMatchObject({
      mood: 'happy',
      simulated: false,
    });
    expect(displayState(apply(petted, { type: 'clock.tick' }, START + 4_000)).mood).toBe('idle');
  });
});

describe('formatDuration', () => {
  it.each([
    [-1, '00:00'],
    [0, '00:00'],
    [1, '00:01'],
    [999, '00:01'],
    [1_001, '00:02'],
    [59_000, '00:59'],
    [59_001, '01:00'],
    [60_000, '01:00'],
    [180 * 60_000, '180:00'],
  ])('formats %s milliseconds as %s without showing negative time', (milliseconds, formatted) => {
    expect(formatDuration(milliseconds)).toBe(formatted);
  });
});

describe('小屏文案', () => {
  const at = (ms: number) => apply(initialState(0), { type: 'clock.tick' }, ms);

  it('没有自定义标语时用内置那句', () => {
    expect(displayState(at(0)).title).toBe('今天也一起吧');
  });

  it('自定义标语按时间轮换，同一时刻结果固定', () => {
    const lines = ['慢慢来', '我在呢'];
    expect(displayState(at(0), { idleLines: lines }).title).toBe('慢慢来');
    expect(displayState(at(19_999), { idleLines: lines }).title).toBe('慢慢来');
    expect(displayState(at(20_000), { idleLines: lines }).title).toBe('我在呢');
    expect(displayState(at(40_000), { idleLines: lines }).title).toBe('慢慢来');
    // 空数组等于没配，不能变成空标题。
    expect(displayState(at(0), { idleLines: [] }).title).toBe('今天也一起吧');
  });

  it('副标题先说待办，再说会话名，最后才是安慰话', () => {
    let state = at(0);
    expect(displayState(state).detail).toBe('不用着急');
    state = apply(state, { type: 'todo.add', title: '写方案' }, 1, 'a');
    state = apply(state, { type: 'todo.add', title: '回邮件' }, 2, 'b');
    expect(displayState(state).detail).toBe('还剩 2 件小事');
    state = apply(state, { type: 'todo.toggle', id: 'a' }, 3);
    state = apply(state, { type: 'todo.toggle', id: 'b' }, 4);
    expect(displayState(state).detail).toBe('都做完了，歇会儿');
    // 用户亲手起过会话名，就盖过这些自动摘要。
    state = apply(state, { type: 'session.set', kind: 'coding', title: '改屏幕' }, 5);
    expect(displayState(state).detail).toBe('改屏幕');
  });

  it('时间只在头部显示，不影响标题', () => {
    const date = new Date(2026, 10, 8, 9, 5);
    expect(formatClock(date.getTime())).toBe('09:05');
    const late = new Date(2026, 10, 8, 23, 59);
    expect(formatClock(late.getTime())).toBe('23:59');
  });
});
