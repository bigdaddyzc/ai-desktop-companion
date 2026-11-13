import { describe, expect, it, vi } from 'vitest';
import type { Action, PersistedState, Snapshot } from '../src/core/schema';
import { durableState, initialState } from '../src/core/state';
import { StateService } from '../src/desktop/service';
import type { Persistence } from '../src/desktop/store';
import { persistedState, simulationEvent } from './fixtures';

const START = 100_000;

function harness(saved: PersistedState | null = null) {
  let now = START;
  let wall = START + 10_000_000;
  let id = 0;
  let disk = structuredClone(saved);
  const store = {
    load: vi.fn<Persistence['load']>(async () => structuredClone(disk)),
    save: vi.fn<Persistence['save']>(async (value) => {
      disk = structuredClone(value);
    }),
  } satisfies Persistence;
  const clock = vi.fn(() => now);
  const wallClock = vi.fn(() => wall);
  const makeId = vi.fn(() => `id-${++id}`);
  const service = new StateService(store, clock, makeId, wallClock);
  return {
    service,
    store,
    clock,
    makeId,
    setNow(value: number) {
      now = value;
    },
    setWall(value: number) {
      wall = value;
    },
    readDisk: () => structuredClone(disk),
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('StateService initialization and input validation', () => {
  it('loads once and does not write when there is no saved state', async () => {
    const { service, store } = harness();
    await service.initialize();
    expect(store.load).toHaveBeenCalledOnce();
    expect(store.save).not.toHaveBeenCalled();
    expect(service.snapshot()).toEqual({ state: initialState(START), storageError: null });
  });

  it('restores durable data but not simulation, interaction or revision state', async () => {
    const saved = persistedState({
      session: { kind: 'document', title: 'Draft proposal' },
      todos: [{ id: 'saved-todo', title: 'Review', done: true, createdAt: 0 }],
      settings: { alwaysOnTop: true, quiet: true, reducedMotion: true },
    });
    const { service, store } = harness(saved);
    await service.initialize();
    expect(durableState(service.snapshot().state)).toEqual(saved);
    expect(service.snapshot().state.simulation).toEqual(initialState(START).simulation);
    expect(service.snapshot().state.petUntil).toBe(0);
    expect(service.snapshot().state.revision).toBe(0);
    expect(store.save).not.toHaveBeenCalled();
  });

  it('persists the recovery gate so repeated launches do not keep consuming timer time', async () => {
    const saved = persistedState({
      timer: {
        id: 'saved-timer',
        status: 'running',
        durationMs: 120_000,
        remainingMs: 120_000,
        startedAt: START - 30_000,
      },
    });
    const { service, store, setNow, readDisk, clock, makeId } = harness(saved);
    await service.initialize();
    expect(store.save).toHaveBeenCalledOnce();
    const recovery = {
      ...saved.timer,
      status: 'recovery',
      remainingMs: 90_000,
      startedAt: null,
      recoveryReason: 'restart',
    };
    expect(service.snapshot().state.timer).toEqual(recovery);
    expect(readDisk()?.timer).toEqual(recovery);

    setNow(START + 600_000);
    const relaunched = new StateService(store, clock, makeId);
    await relaunched.initialize();
    expect(relaunched.snapshot().state.timer).toEqual(recovery);
    expect(store.save).toHaveBeenCalledOnce();
    expect((await relaunched.dispatch({ type: 'timer.resume' })).ok).toBe(true);
    expect(relaunched.snapshot().state.timer).toMatchObject({
      status: 'running',
      remainingMs: 90_000,
      startedAt: START + 600_000,
    });
    expect(readDisk()?.timer).toEqual(relaunched.snapshot().state.timer);
  });

  it.each(['paused', 'recovery', 'completed'] as const)(
    'does not rewrite a persisted %s timer on launch',
    async (status) => {
      const saved = persistedState({
        timer: {
          id: 'saved-timer',
          status,
          durationMs: 60_000,
          remainingMs: status === 'completed' ? 0 : 20_000,
          startedAt: null,
        },
      });
      const { service, store } = harness(saved);
      await service.initialize();
      expect(service.snapshot().state.timer).toEqual(saved.timer);
      expect(store.save).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    {},
    { type: 'clock.tick' },
    { type: 'timer.start', minutes: 0 },
    { type: 'timer.start', minutes: '25' },
    { type: 'todo.add', title: '  ' },
    { type: 'todo.add', title: 'Valid', command: 'not allowed' },
    { type: 'settings.patch', patch: { quiet: 'yes' } },
    { type: 'sim.event', event: { ...simulationEvent(), sourceId: 'external' } },
  ])('rejects invalid boundary input %# without allocating ids or publishing', async (raw) => {
    const { service, store, makeId } = harness();
    await service.initialize();
    const listener = vi.fn();
    service.subscribe(listener);
    const before = service.snapshot();
    expect(await service.dispatch(raw)).toEqual({
      ok: false,
      error: '无效操作：输入格式或参数超出允许范围。',
    });
    expect(service.snapshot()).toEqual(before);
    expect(store.save).not.toHaveBeenCalled();
    expect(makeId).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('normalizes accepted input and uses injected ids and timestamps', async () => {
    const { service, store } = harness();
    await service.initialize();
    const result = await service.dispatch({ type: 'todo.add', title: '  Write tests\n' });
    expect(result).toMatchObject({ ok: true });
    const todo = { id: 'id-1', title: 'Write tests', done: false, createdAt: START };
    expect(service.snapshot().state.todos).toEqual([todo]);
    expect(store.save).toHaveBeenCalledWith(persistedState({ todos: [todo] }));
  });

  it('keeps state and storage unchanged when the reducer rejects an operation', async () => {
    const { service, store } = harness();
    await service.initialize();
    await service.dispatch({ type: 'timer.start', minutes: 1 });
    const before = service.snapshot();
    const listener = vi.fn();
    service.subscribe(listener);
    store.save.mockClear();
    expect(await service.dispatch({ type: 'timer.start', minutes: 2 })).toEqual({
      ok: false,
      error: '请先结束当前计时。',
    });
    expect(service.snapshot()).toEqual(before);
    expect(store.save).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect((await service.dispatch({ type: 'timer.cancel' })).ok).toBe(true);
  });
});

describe('serialized writes and publication', () => {
  it('waits for persistence before publishing and serializes concurrent commands against committed state', async () => {
    const { service, store } = harness();
    await service.initialize();
    const entered = deferred();
    const gate = deferred();
    store.save.mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
    });
    const listener = vi.fn<(snapshot: Snapshot) => void>();
    service.subscribe(listener);
    const before = service.snapshot();
    const first = service.dispatch({ type: 'todo.add', title: 'First' });
    await entered.promise;
    const second = service.dispatch({ type: 'todo.add', title: 'Second' });
    let settled = false;
    const settling = service.settled().then(() => {
      settled = true;
    });
    expect(store.save).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
    expect(service.snapshot()).toEqual(before);
    expect(settled).toBe(false);

    gate.resolve();
    const results = await Promise.all([first, second]);
    await settling;
    expect(results.map((result) => result.ok)).toEqual([true, true]);
    expect(settled).toBe(true);
    expect(store.save).toHaveBeenCalledTimes(2);
    expect(store.save.mock.calls.map(([value]) => value.todos.map((todo) => todo.title))).toEqual([
      ['First'],
      ['Second', 'First'],
    ]);
    expect(
      listener.mock.calls.map(([snapshot]) => snapshot.state.todos.map((todo) => todo.title)),
    ).toEqual([['First'], ['Second', 'First']]);
    expect(listener.mock.calls.map(([snapshot]) => snapshot.state.revision)).toEqual([1, 2]);
    expect(service.snapshot().state.todos.map((todo) => todo.id)).toEqual(['id-2', 'id-1']);
  });

  it('queues tick and clear behind a pending dispatch without overlapping writes', async () => {
    const { service, store, setNow } = harness();
    await service.initialize();
    const entered = deferred();
    const gate = deferred();
    store.save.mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
    });
    const listener = vi.fn<(snapshot: Snapshot) => void>();
    service.subscribe(listener);
    const start = service.dispatch({ type: 'timer.start', minutes: 1 });
    await entered.promise;
    setNow(START + 60_000);
    const tick = service.tick();
    const clear = service.clear();
    expect(store.save).toHaveBeenCalledOnce();
    expect(service.snapshot().state.timer).toBeNull();
    gate.resolve();
    expect((await Promise.all([start, tick, clear])).map((result) => result.ok)).toEqual([
      true,
      true,
      true,
    ]);
    await service.settled();
    expect(store.save.mock.calls.map(([value]) => value.timer?.status ?? null)).toEqual([
      'running',
      'completed',
      null,
    ]);
    expect(listener.mock.calls.map(([snapshot]) => snapshot.state.timer?.status ?? null)).toEqual([
      'running',
      'completed',
      null,
    ]);
    expect(service.snapshot().state.revision).toBe(3);
    expect(durableState(service.snapshot().state)).toEqual(persistedState());
  });

  it('publishes an error but never a failed modification, and allows the queued operation to succeed', async () => {
    const { service, store } = harness();
    await service.initialize();
    const before = service.snapshot().state;
    const entered = deferred();
    const gate = deferred();
    store.save.mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
    });
    const listener = vi.fn<(snapshot: Snapshot) => void>();
    service.subscribe(listener);
    const failed = service.dispatch({ type: 'todo.add', title: 'Must not appear' });
    await entered.promise;
    const succeeding = service.dispatch({ type: 'todo.add', title: 'Committed' });
    expect(listener).not.toHaveBeenCalled();
    gate.reject(new Error('disk full'));
    expect(await failed).toMatchObject({ ok: false, error: expect.stringContaining('保存失败') });
    expect(await succeeding).toMatchObject({ ok: true });
    await service.settled();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[0]?.[0]).toEqual({
      state: before,
      storageError: '保存失败，修改未生效。请检查磁盘空间或文件权限，然后重试。',
    });
    expect(listener.mock.calls[1]?.[0].storageError).toBeNull();
    expect(service.snapshot().state.todos).toEqual([
      { id: 'id-2', title: 'Committed', done: false, createdAt: START },
    ]);
    expect(service.snapshot().state.revision).toBe(1);
    expect(store.save.mock.calls[1]?.[0].todos.map((todo) => todo.title)).toEqual(['Committed']);
  });

  it.each<Action>([
    { type: 'session.set', kind: 'coding', title: 'Changed session' },
    { type: 'todo.add', title: 'Changed todo' },
    { type: 'todo.toggle', id: 'saved-todo' },
    { type: 'todo.remove', id: 'saved-todo' },
    { type: 'timer.start', minutes: 1 },
    { type: 'settings.patch', patch: { quiet: true } },
  ])('rolls back $type completely when saving fails', async (action) => {
    const { service, store } = harness(
      persistedState({ todos: [{ id: 'saved-todo', title: 'Keep', done: false, createdAt: 0 }] }),
    );
    await service.initialize();
    const before = service.snapshot().state;
    const listener = vi.fn<(snapshot: Snapshot) => void>();
    service.subscribe(listener);
    store.save.mockRejectedValueOnce(new Error('denied'));
    expect(await service.dispatch(action)).toMatchObject({ ok: false });
    expect(service.snapshot().state).toEqual(before);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0].state).toEqual(before);
  });

  it('does not publish timer expiry on a failed tick save, then retries it successfully', async () => {
    const { service, store, setNow } = harness();
    await service.initialize();
    await service.dispatch({ type: 'timer.start', minutes: 1 });
    const before = service.snapshot().state;
    setNow(START + 60_000);
    store.save.mockRejectedValueOnce(new Error('disk full'));
    const listener = vi.fn<(snapshot: Snapshot) => void>();
    service.subscribe(listener);
    expect(await service.tick()).toMatchObject({ ok: false });
    expect(service.snapshot().state).toEqual(before);
    expect(listener.mock.calls[0]?.[0].state.timer?.status).toBe('running');
    expect(await service.tick()).toMatchObject({ ok: true });
    expect(service.snapshot().state.timer).toMatchObject({
      status: 'completed',
      remainingMs: 0,
      startedAt: null,
    });
    expect(service.snapshot().storageError).toBeNull();
  });
});

describe('simulation persistence isolation', () => {
  it('does not save simulation-only, pet or ordinary clock changes', async () => {
    const saved = persistedState({ session: { kind: 'design', title: 'Real local session' } });
    const { service, store, setNow } = harness(saved);
    await service.initialize();
    const actions: Action[] = [
      { type: 'sim.event', event: simulationEvent() },
      { type: 'sim.event', event: simulationEvent() },
      { type: 'sim.connect', connected: false },
      { type: 'sim.event', event: simulationEvent({ eventId: 'dropped' }) },
      { type: 'sim.connect', connected: true },
      { type: 'pet.interact' },
      { type: 'sim.reset' },
    ];
    for (const action of actions) {
      expect((await service.dispatch(action)).ok).toBe(true);
      expect(durableState(service.snapshot().state)).toEqual(saved);
    }
    setNow(START + 10_000);
    expect((await service.tick()).ok).toBe(true);
    expect(store.save).not.toHaveBeenCalled();
  });

  it('never includes simulation or interaction state in a later business-data save', async () => {
    const { service, store, clock, makeId } = harness();
    await service.initialize();
    await service.dispatch({
      type: 'sim.event',
      event: simulationEvent({ progress: { completed: 2, total: 10 } }),
    });
    await service.dispatch({ type: 'sim.connect', connected: false });
    await service.dispatch({ type: 'pet.interact' });
    await service.dispatch({ type: 'todo.add', title: 'Keep locally' });
    expect(service.snapshot().state.simulation.tasks).toHaveLength(1);
    expect(store.save).toHaveBeenCalledOnce();
    expect(store.save.mock.calls[0]?.[0]).toEqual(
      persistedState({
        todos: [{ id: 'id-4', title: 'Keep locally', done: false, createdAt: START }],
      }),
    );
    const relaunched = new StateService(store, clock, makeId);
    await relaunched.initialize();
    expect(relaunched.snapshot().state.todos).toEqual(service.snapshot().state.todos);
    expect(relaunched.snapshot().state.simulation).toEqual(initialState(START).simulation);
    expect(relaunched.snapshot().state.petUntil).toBe(0);
  });

  it('persists timer expiry triggered by a simulation event, but not the event itself', async () => {
    const { service, store, setNow } = harness();
    await service.initialize();
    await service.dispatch({ type: 'timer.start', minutes: 1 });
    store.save.mockClear();
    setNow(START + 60_000);
    expect((await service.dispatch({ type: 'sim.event', event: simulationEvent() })).ok).toBe(true);
    expect(store.save).toHaveBeenCalledOnce();
    expect(store.save.mock.calls[0]?.[0].timer?.status).toBe('completed');
    expect(store.save.mock.calls[0]?.[0]).not.toHaveProperty('simulation');
    expect(service.snapshot().state.simulation.tasks).toHaveLength(1);
  });
});

describe('storage errors and clear', () => {
  it.each([new Error('Corrupt original file'), 'unreadable'])(
    'locks durable writes after a load failure (%s)',
    async (error) => {
      const { service, store } = harness();
      store.load.mockRejectedValueOnce(error);
      await service.initialize();
      const storageError = error instanceof Error ? error.message : '无法加载本地数据。';
      expect(service.snapshot().storageError).toBe(storageError);
      const before = service.snapshot().state;
      const listener = vi.fn();
      service.subscribe(listener);
      for (const action of [
        { type: 'todo.add', title: 'Do not overwrite' },
        { type: 'timer.start', minutes: 1 },
        { type: 'settings.patch', patch: { quiet: true } },
      ]) {
        expect(await service.dispatch(action)).toEqual({ ok: false, error: storageError });
      }
      expect(await service.clear()).toMatchObject({
        ok: false,
        error: expect.stringContaining('禁止覆盖'),
      });
      expect(service.snapshot().state).toEqual(before);
      expect(store.save).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      expect((await service.dispatch({ type: 'sim.event', event: simulationEvent() })).ok).toBe(
        true,
      );
      expect((await service.dispatch({ type: 'pet.interact' })).ok).toBe(true);
      expect(store.save).not.toHaveBeenCalled();
      expect(service.snapshot().storageError).toBe(storageError);
    },
  );

  it('enters read-only mode when the recovery checkpoint cannot be saved', async () => {
    const saved = persistedState({
      timer: {
        id: 'timer',
        status: 'running',
        durationMs: 60_000,
        remainingMs: 60_000,
        startedAt: START,
      },
    });
    const { service, store, readDisk } = harness(saved);
    store.save.mockRejectedValueOnce(new Error('Recovery save denied'));
    await service.initialize();
    expect(service.snapshot().storageError).toBe('Recovery save denied');
    expect(readDisk()).toEqual(saved);
    expect((await service.dispatch({ type: 'timer.resume' })).ok).toBe(false);
    expect((await service.clear()).ok).toBe(false);
    expect(store.save).toHaveBeenCalledOnce();
  });

  it('clears durable and transient state with one saved reset before publishing', async () => {
    const { service, store, setNow, readDisk } = harness();
    await service.initialize();
    await service.dispatch({ type: 'todo.add', title: 'Remove me' });
    await service.dispatch({ type: 'settings.patch', patch: { quiet: true } });
    await service.dispatch({ type: 'session.set', kind: 'coding', title: 'Remove session' });
    await service.dispatch({ type: 'timer.start', minutes: 2 });
    await service.dispatch({ type: 'sim.event', event: simulationEvent() });
    await service.dispatch({ type: 'sim.connect', connected: false });
    await service.dispatch({ type: 'pet.interact' });
    const revision = service.snapshot().state.revision;
    const before = service.snapshot();
    const entered = deferred();
    const gate = deferred();
    const save = store.save.getMockImplementation()!;
    store.save.mockImplementationOnce(async (value) => {
      entered.resolve();
      await gate.promise;
      await save(value);
    });
    const listener = vi.fn();
    service.subscribe(listener);
    setNow(START + 1_000);
    const clearing = service.clear();
    await entered.promise;
    expect(service.snapshot()).toEqual(before);
    expect(listener).not.toHaveBeenCalled();
    gate.resolve();
    expect(await clearing).toMatchObject({ ok: true });
    expect(service.snapshot()).toEqual({
      state: { ...initialState(START + 1_000), revision: revision + 1 },
      storageError: null,
    });
    expect(readDisk()).toEqual(persistedState());
    expect(listener).toHaveBeenCalledOnce();
  });

  it('keeps both durable and simulation state if clear cannot be saved, then permits retry', async () => {
    const { service, store, readDisk } = harness();
    await service.initialize();
    await service.dispatch({ type: 'todo.add', title: 'Keep until committed' });
    await service.dispatch({ type: 'sim.event', event: simulationEvent() });
    const before = service.snapshot().state;
    const saved = readDisk();
    const listener = vi.fn<(snapshot: Snapshot) => void>();
    service.subscribe(listener);
    store.save.mockRejectedValueOnce(new Error('Cannot clear'));
    expect((await service.clear()).ok).toBe(false);
    expect(service.snapshot().state).toEqual(before);
    expect(readDisk()).toEqual(saved);
    expect(listener.mock.calls[0]?.[0].state).toEqual(before);
    expect((await service.clear()).ok).toBe(true);
    expect(readDisk()).toEqual(persistedState());
    expect(service.snapshot().state.simulation.tasks).toEqual([]);
    expect(service.snapshot().storageError).toBeNull();
  });
});

describe('snapshot and subscription isolation', () => {
  it('returns deep copies from snapshots and command results', async () => {
    const { service } = harness();
    await service.initialize();
    const result = await service.dispatch({ type: 'todo.add', title: 'Original' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    result.snapshot.state.todos[0]!.title = 'Result mutation';
    const snapshot = service.snapshot();
    snapshot.state.todos[0]!.done = true;
    snapshot.state.settings.quiet = true;
    snapshot.state.simulation.seenIds.push('not-real');
    expect(service.snapshot().state.todos).toEqual([
      { id: 'id-1', title: 'Original', done: false, createdAt: START },
    ]);
    expect(service.snapshot().state.settings.quiet).toBe(false);
    expect(service.snapshot().state.simulation.seenIds).toEqual([]);
  });

  it('isolates subscriber snapshots and stops notifying an unsubscribed listener', async () => {
    const { service } = harness();
    await service.initialize();
    const mutator = vi.fn((snapshot: Snapshot) => {
      snapshot.state.settings.quiet = true;
      snapshot.state.simulation.tasks.length = 0;
    });
    const observer = vi.fn<(snapshot: Snapshot) => void>();
    const unsubscribe = service.subscribe(mutator);
    service.subscribe(observer);
    await service.dispatch({ type: 'sim.event', event: simulationEvent() });
    expect(observer.mock.calls[0]?.[0].state.settings.quiet).toBe(false);
    expect(observer.mock.calls[0]?.[0].state.simulation.tasks).toHaveLength(1);
    expect(service.snapshot().state.simulation.tasks).toHaveLength(1);
    unsubscribe();
    await service.dispatch({ type: 'pet.interact' });
    expect(mutator).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledTimes(2);
  });
});

describe('system sleep and clock jumps', () => {
  it('gates a running timer when the wall clock runs ahead of the monotonic clock', async () => {
    const { service, setNow, setWall } = harness();
    await service.initialize();
    await service.dispatch({ type: 'timer.start', minutes: 5 });
    await service.tick(); // 建立基准

    // 单调时钟只走了 2 秒，墙钟走了 10 分钟：典型系统休眠。
    setNow(START + 2_000);
    setWall(START + 10_000_000 + 600_000);
    await service.tick();

    expect(service.snapshot().state.timer).toMatchObject({
      status: 'recovery',
      recoveryReason: 'clock-jump',
      remainingMs: 298_000,
      startedAt: null,
    });
    // 恢复到运行态后不再反复触发。
    setNow(START + 3_000);
    setWall(START + 10_000_000 + 601_000);
    await service.dispatch({ type: 'timer.resume' });
    await service.tick();
    expect(service.snapshot().state.timer).toMatchObject({ status: 'running' });
    expect(service.snapshot().state.timer?.recoveryReason).toBeUndefined();
  });

  it('does not gate a normal tick or a small drift', async () => {
    const { service, setNow, setWall } = harness();
    await service.initialize();
    await service.dispatch({ type: 'timer.start', minutes: 5 });
    await service.tick();
    for (let step = 1; step <= 5; step += 1) {
      setNow(START + step * 1_000);
      setWall(START + 10_000_000 + step * 1_000 + (step === 3 ? 800 : 0));
      await service.tick();
    }
    expect(service.snapshot().state.timer).toMatchObject({ status: 'running' });
    expect(service.snapshot().state.timer?.recoveryReason).toBeUndefined();
  });
});
