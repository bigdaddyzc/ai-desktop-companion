import type { PersistedState, SimulationEvent } from '../src/core/schema';

export function persistedState(overrides: Partial<PersistedState> = {}): PersistedState {
  return {
    version: 1,
    session: { kind: 'idle', title: '自由时光' },
    timer: null,
    todos: [],
    settings: { alwaysOnTop: false, quiet: false, reducedMotion: false },
    ...overrides,
  };
}

export function simulationEvent(overrides: Partial<SimulationEvent> = {}): SimulationEvent {
  return {
    schemaVersion: 1,
    simulation: true,
    eventId: 'event-1',
    sourceId: 'local-simulator',
    taskId: 'task-1',
    sequence: 0,
    title: 'Run tests',
    status: 'running',
    ...overrides,
  };
}
