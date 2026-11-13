import { describe, expect, it } from 'vitest';
import {
  actionSchema,
  persistedSchema,
  progressSchema,
  sessionKindSchema,
  settingsSchema,
  simulationEventSchema,
  type Timer,
} from '../src/core/schema';
import { persistedState, simulationEvent } from './fixtures';

describe('actionSchema', () => {
  it.each([
    { type: 'session.set', kind: 'coding', title: 'Write tests' },
    { type: 'todo.add', title: 'Write tests' },
    { type: 'todo.toggle', id: 'todo-1' },
    { type: 'todo.remove', id: 'todo-1' },
    { type: 'timer.start', minutes: 1 },
    { type: 'timer.start', minutes: 180 },
    { type: 'timer.pause' },
    { type: 'timer.resume' },
    { type: 'timer.cancel' },
    { type: 'settings.patch', patch: {} },
    { type: 'settings.patch', patch: { quiet: true } },
    { type: 'pet.interact' },
    { type: 'sim.connect', connected: false },
    { type: 'sim.event', event: simulationEvent() },
    { type: 'sim.reset' },
  ])('accepts the supported action $type', (action) => {
    expect(actionSchema.parse(action)).toEqual(action);
    expect(actionSchema.safeParse({ ...action, unexpected: true }).success).toBe(false);
  });

  it.each(['idle', 'coding', 'design', 'document', 'entertainment'])(
    'accepts the %s session kind',
    (kind) => {
      expect(sessionKindSchema.parse(kind)).toBe(kind);
    },
  );

  it.each(['session.set', 'todo.add'] as const)('trims %s titles before use', (type) => {
    const action =
      type === 'session.set'
        ? { type, kind: 'document', title: '  Review proposal\n' }
        : { type, title: '  Review proposal\n' };
    expect(actionSchema.parse(action)).toEqual({ ...action, title: 'Review proposal' });
    expect(actionSchema.safeParse({ ...action, title: 'x'.repeat(100) }).success).toBe(true);
  });

  it.each([
    ['null', null],
    ['array', []],
    ['missing type', {}],
    ['unknown action', { type: 'shell.execute', command: 'not allowed' }],
    ['internal clock action', { type: 'clock.tick' }],
    ['unsupported session kind', { type: 'session.set', kind: 'automatic', title: 'Task' }],
    ['empty title', { type: 'todo.add', title: '' }],
    ['whitespace title', { type: 'todo.add', title: ' \t\n ' }],
    ['long title', { type: 'todo.add', title: 'x'.repeat(101) }],
    ['non-string title', { type: 'todo.add', title: 42 }],
    ['missing title', { type: 'todo.add' }],
    ['empty id', { type: 'todo.toggle', id: '' }],
    ['long id', { type: 'todo.remove', id: 'x'.repeat(129) }],
    ['non-string id', { type: 'todo.remove', id: 1 }],
    ['zero minutes', { type: 'timer.start', minutes: 0 }],
    ['negative minutes', { type: 'timer.start', minutes: -1 }],
    ['overlong duration', { type: 'timer.start', minutes: 181 }],
    ['fractional minutes', { type: 'timer.start', minutes: 1.5 }],
    ['string minutes', { type: 'timer.start', minutes: '25' }],
    ['infinite minutes', { type: 'timer.start', minutes: Infinity }],
    ['NaN minutes', { type: 'timer.start', minutes: NaN }],
    ['unknown setting', { type: 'settings.patch', patch: { telemetry: true } }],
    ['coerced setting', { type: 'settings.patch', patch: { quiet: 'true' } }],
    ['null patch', { type: 'settings.patch', patch: null }],
    ['coerced connection flag', { type: 'sim.connect', connected: 1 }],
    [
      'unlabelled simulation',
      { type: 'sim.event', event: { ...simulationEvent(), simulation: false } },
    ],
  ])('rejects %s', (_name, input) => {
    expect(actionSchema.safeParse(input).success).toBe(false);
  });

  it('accepts ids at the maximum length without silently truncating them', () => {
    const action = { type: 'todo.toggle', id: 'x'.repeat(128) };
    expect(actionSchema.parse(action)).toEqual(action);
  });
});

describe('progressSchema and simulationEventSchema', () => {
  it.each([
    { completed: 0, total: 1 },
    { completed: 3, total: 10 },
    { completed: 10, total: 10 },
  ])('accepts explicit progress $completed/$total', (progress) => {
    expect(progressSchema.parse(progress)).toEqual(progress);
    expect(simulationEventSchema.parse(simulationEvent({ progress })).progress).toEqual(progress);
  });

  it.each([
    ['zero total', { completed: 0, total: 0 }],
    ['negative total', { completed: 0, total: -1 }],
    ['negative completed', { completed: -1, total: 10 }],
    ['completed above total', { completed: 11, total: 10 }],
    ['fractional completed', { completed: 0.5, total: 10 }],
    ['fractional total', { completed: 0, total: 1.5 }],
    ['infinite total', { completed: 0, total: Infinity }],
    ['NaN completed', { completed: NaN, total: 10 }],
    ['missing total', { completed: 1 }],
    ['missing completed', { total: 10 }],
    ['string counts', { completed: '1', total: '10' }],
    ['invented percentage', { completed: 1, total: 10, percent: 10 }],
    ['null progress', null],
  ])('rejects %s', (_name, progress) => {
    expect(progressSchema.safeParse(progress).success).toBe(false);
    expect(simulationEventSchema.safeParse({ ...simulationEvent(), progress }).success).toBe(false);
  });

  it('keeps absent progress absent and trims event titles', () => {
    const parsed = simulationEventSchema.parse(simulationEvent({ title: '  Tests  ' }));
    expect(parsed.title).toBe('Tests');
    expect(parsed).not.toHaveProperty('progress');
  });

  it.each(['running', 'waiting', 'succeeded', 'failed', 'cancelled'] as const)(
    'accepts the explicit %s status without requiring a percentage',
    (status) => {
      expect(simulationEventSchema.parse(simulationEvent({ status })).status).toBe(status);
    },
  );

  it.each([
    ['unknown version', { schemaVersion: 2 }],
    ['missing simulation label', { simulation: undefined }],
    ['real-data label', { simulation: false }],
    ['foreign source', { sourceId: 'vscode' }],
    ['empty event id', { eventId: '' }],
    ['overlong event id', { eventId: 'x'.repeat(129) }],
    ['empty task id', { taskId: '' }],
    ['overlong task id', { taskId: 'x'.repeat(129) }],
    ['negative sequence', { sequence: -1 }],
    ['fractional sequence', { sequence: 0.5 }],
    ['string sequence', { sequence: '1' }],
    ['infinite sequence', { sequence: Infinity }],
    ['blank title', { title: '  ' }],
    ['overlong title', { title: 'x'.repeat(101) }],
    ['unknown status', { status: 'done' }],
    ['extra field', { command: 'execute' }],
  ])('rejects events with %s', (_name, patch) => {
    expect(simulationEventSchema.safeParse({ ...simulationEvent(), ...patch }).success).toBe(false);
  });
});

describe('persistedSchema', () => {
  const runningTimer: Timer = {
    id: 'timer-1',
    status: 'running',
    durationMs: 60_000,
    remainingMs: 45_000,
    startedAt: 1_000,
  };

  it('accepts only the versioned durable shape, normalizing titles', () => {
    const input = persistedState({
      session: { kind: 'design', title: '  Design  ' },
      todos: [{ id: 'todo-1', title: '  Sketch  ', done: false, createdAt: 0 }],
    });
    expect(persistedSchema.parse(input)).toEqual({
      ...input,
      session: { kind: 'design', title: 'Design' },
      todos: [{ id: 'todo-1', title: 'Sketch', done: false, createdAt: 0 }],
    });
  });

  it.each([
    runningTimer,
    { ...runningTimer, status: 'paused', startedAt: null },
    { ...runningTimer, status: 'recovery', startedAt: null },
    { ...runningTimer, status: 'recovery', remainingMs: 0, startedAt: null },
    { ...runningTimer, status: 'completed', remainingMs: 0, startedAt: null },
    { ...runningTimer, durationMs: 180 * 60_000, remainingMs: 180 * 60_000 },
  ])('accepts a consistent $status timer', (timer) => {
    expect(persistedSchema.parse({ ...persistedState(), timer }).timer).toEqual(timer);
  });

  it.each([
    ['missing id', { id: '' }],
    ['unknown status', { status: 'stopped' }],
    ['zero duration', { durationMs: 0, remainingMs: 0 }],
    ['fractional duration', { durationMs: 60_000.5 }],
    ['overlong duration', { durationMs: 180 * 60_000 + 1 }],
    ['negative remaining time', { remainingMs: -1 }],
    ['remaining time above duration', { remainingMs: 60_001 }],
    ['infinite remaining time', { remainingMs: Infinity }],
    ['negative timestamp', { startedAt: -1 }],
    ['infinite timestamp', { startedAt: Infinity }],
    ['running without a start', { startedAt: null }],
    ['paused with a start', { status: 'paused' }],
    ['recovery with a start', { status: 'recovery' }],
    ['completed with a start', { status: 'completed', remainingMs: 0 }],
    ['completed with time left', { status: 'completed', startedAt: null }],
    ['unknown field', { elapsed: 0 }],
  ])('rejects an inconsistent timer: %s', (_name, patch) => {
    const timer = { ...runningTimer, ...patch };
    expect(persistedSchema.safeParse({ ...persistedState(), timer }).success).toBe(false);
  });

  it.each([
    ['missing version', { version: undefined }],
    ['future version', { version: 2 }],
    ['string version', { version: '1' }],
    ['simulation data', { simulation: { tasks: [] } }],
    ['revision', { revision: 1 }],
    ['clock', { now: 1_000 }],
    ['pet state', { petUntil: 2_000 }],
    ['missing settings', { settings: undefined }],
    ['partial settings', { settings: { quiet: true } }],
    ['nonboolean settings', { settings: { alwaysOnTop: 0, quiet: false, reducedMotion: false } }],
    ['extra session fields', { session: { kind: 'idle', title: 'Local', source: 'remote' } }],
    ['blank session title', { session: { kind: 'idle', title: ' ' } }],
    ['invalid todo timestamp', { todos: [{ id: 'a', title: 'Todo', done: false, createdAt: -1 }] }],
    [
      'nonboolean todo completion',
      { todos: [{ id: 'a', title: 'Todo', done: 'false', createdAt: 0 }] },
    ],
    [
      'extra todo fields',
      { todos: [{ id: 'a', title: 'Todo', done: false, createdAt: 0, percent: 0 }] },
    ],
  ])('rejects persisted data with %s', (_name, patch) => {
    expect(persistedSchema.safeParse({ ...persistedState(), ...patch }).success).toBe(false);
  });

  it('enforces the 1,000-todo limit without dropping records', () => {
    const todos = Array.from({ length: 1_000 }, (_, index) => ({
      id: `todo-${index}`,
      title: 'Todo',
      done: false,
      createdAt: 0,
    }));
    expect(persistedSchema.parse(persistedState({ todos })).todos).toHaveLength(1_000);
    expect(
      persistedSchema.safeParse({ ...persistedState(), todos: [...todos, todos[0]] }).success,
    ).toBe(false);
  });

  it('rejects unknown settings even outside an action', () => {
    const settings = persistedState().settings;
    expect(settingsSchema.parse(settings)).toEqual(settings);
    expect(settingsSchema.safeParse({ ...settings, autoplay: true }).success).toBe(false);
  });
});
