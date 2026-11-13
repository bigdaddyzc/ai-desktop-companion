import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { durableState, initialState } from '../src/core/state';
import { StateService } from '../src/desktop/service';
import { JsonStore } from '../src/desktop/store';
import { persistedState, simulationEvent } from './fixtures';

const START = 100_000;
// 迁移框架会区分「版本更新」与「文件损坏」，错误信息更具体；此处只断言共同的安全结果。
const READ_ONLY = '当前为只读安全模式。';
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'companion-store-test-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('JsonStore load and save', () => {
  it('returns null for a missing file without creating it or its parent directory', async () => {
    const store = new JsonStore(join(directory, 'not-created', 'state.json'));
    expect(await store.load()).toBeNull();
    expect(await readdir(directory)).toEqual([]);
  });

  it('creates parent directories, round-trips data and leaves no temporary file', async () => {
    const parent = join(directory, 'nested', 'data');
    const path = join(parent, 'state.json');
    const store = new JsonStore(path);
    const value = persistedState({
      session: { kind: 'document', title: '中文与 Unicode café' },
      timer: {
        id: 'timer-1',
        status: 'paused',
        durationMs: 60_000,
        remainingMs: 15_000,
        startedAt: null,
      },
      todos: [{ id: 'todo-1', title: 'Review proposal', done: true, createdAt: START }],
      settings: { alwaysOnTop: true, quiet: true, reducedMotion: true },
    });
    await store.save(value);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(value);
    expect(await new JsonStore(path).load()).toEqual(value);
    expect(await readdir(parent)).toEqual(['state.json']);
  });

  it('replaces the previous complete file on a second save', async () => {
    const path = join(directory, 'state.json');
    const store = new JsonStore(path);
    await store.save(persistedState({ session: { kind: 'coding', title: 'Old session' } }));
    const replacement = persistedState({
      todos: [{ id: 'new-todo', title: 'Replacement', done: false, createdAt: START }],
    });
    await store.save(replacement);
    expect(await store.load()).toEqual(replacement);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(replacement);
    expect(await readdir(directory)).toEqual(['state.json']);
  });

  it('validates and normalizes data before writing it', async () => {
    const path = join(directory, 'state.json');
    const store = new JsonStore(path);
    const value = persistedState({ session: { kind: 'design', title: '  Sketch  ' } });
    await store.save(value);
    expect(await store.load()).toEqual({ ...value, session: { kind: 'design', title: 'Sketch' } });
    expect(value.session.title).toBe('  Sketch  ');
  });

  it('rejects invalid save data without altering an existing file or leaving temporary files', async () => {
    const path = join(directory, 'state.json');
    const store = new JsonStore(path);
    await store.save(persistedState());
    const original = await readFile(path);
    await expect(
      store.save(persistedState({ session: { kind: 'idle', title: '   ' } })),
    ).rejects.toThrow();
    expect((await readFile(path)).equals(original)).toBe(true);
    expect(await readdir(directory)).toEqual(['state.json']);
  });

  it('rejects AppState extras instead of leaking simulation to disk', async () => {
    const store = new JsonStore(join(directory, 'not-created', 'state.json'));
    const state = initialState(START);
    state.simulation.seenIds.push('private-simulation-event');
    await expect(store.save(state)).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  it('cleans up the temporary file when replacing the target fails', async () => {
    // A non-empty directory cannot be replaced by the saved file on Windows or POSIX.
    const target = join(directory, 'state.json');
    await mkdir(target);
    const sentinel = join(target, 'keep.txt');
    await writeFile(sentinel, 'Do not overwrite', 'utf8');
    await expect(new JsonStore(target).save(persistedState())).rejects.toThrow();
    expect(await readFile(sentinel, 'utf8')).toBe('Do not overwrite');
    expect((await stat(target)).isDirectory()).toBe(true);
    expect(await readdir(directory)).toEqual(['state.json']);
    expect(await readdir(target)).toEqual(['keep.txt']);
  });

  it('accepts a valid file exactly at the two-MiB size limit', async () => {
    const path = join(directory, 'state.json');
    const json = JSON.stringify(persistedState());
    const padded = json + ' '.repeat(2 * 1024 * 1024 - Buffer.byteLength(json));
    await writeFile(path, padded, 'utf8');
    expect((await stat(path)).size).toBe(2 * 1024 * 1024);
    expect(await new JsonStore(path).load()).toEqual(persistedState());
  });
});

describe('corrupt JSON preservation', () => {
  it.each([
    ['truncated JSON', '{"version":1,"todos":['],
    ['empty file', ''],
    ['JSON null', 'null'],
    ['unsupported version', JSON.stringify({ ...persistedState(), version: 2 })],
    ['missing fields', JSON.stringify({ version: 1 })],
    [
      'invalid durable data',
      JSON.stringify(persistedState({ session: { kind: 'idle', title: '' } })),
    ],
    [
      'transient simulation data',
      JSON.stringify({ ...persistedState(), simulation: { tasks: [] } }),
    ],
    ['oversized JSON', JSON.stringify(persistedState()) + ' '.repeat(2 * 1024 * 1024)],
  ])('rejects %s and preserves its exact bytes', async (_name, contents) => {
    const path = join(directory, 'state.json');
    await writeFile(path, contents, 'utf8');
    const original = await readFile(path);
    const store = new JsonStore(path);
    await expect(store.load()).rejects.toThrow(READ_ONLY);
    expect((await readFile(path)).equals(original)).toBe(true);
    expect(await readdir(directory)).toEqual(['state.json']);
  });

  it('treats a directory at the data path as unreadable rather than a missing store', async () => {
    const path = join(directory, 'state.json');
    await mkdir(path);
    await expect(new JsonStore(path).load()).rejects.toThrow(READ_ONLY);
    expect((await stat(path)).isDirectory()).toBe(true);
  });

  it('prevents dispatch and clear from overwriting a corrupt original file', async () => {
    const path = join(directory, 'state.json');
    const original = Buffer.from('{"version":1,"important":"keep these bytes"', 'utf8');
    await writeFile(path, original);
    const service = new StateService(
      new JsonStore(path),
      () => START,
      () => 'test-id',
    );
    await service.initialize();
    expect(service.snapshot().storageError).toContain(READ_ONLY);
    const before = service.snapshot().state;
    expect(
      await service.dispatch({ type: 'todo.add', title: 'Must not replace original' }),
    ).toEqual({
      ok: false,
      error: expect.stringContaining(READ_ONLY),
    });
    expect(await service.clear()).toMatchObject({
      ok: false,
      error: expect.stringContaining('禁止覆盖'),
    });
    expect(service.snapshot().state).toEqual(before);
    expect((await service.dispatch({ type: 'sim.event', event: simulationEvent() })).ok).toBe(true);
    expect(service.snapshot().state.simulation.tasks).toHaveLength(1);
    expect((await readFile(path)).equals(original)).toBe(true);
    expect(await readdir(directory)).toEqual(['state.json']);
  });
});

describe('JsonStore with StateService.clear', () => {
  it('saves the default durable state and restores an empty store after clear', async () => {
    const path = join(directory, 'state.json');
    const store = new JsonStore(path);
    await store.save(
      persistedState({
        session: { kind: 'coding', title: 'Clear this session' },
        timer: {
          id: 'saved-timer',
          status: 'paused',
          durationMs: 60_000,
          remainingMs: 30_000,
          startedAt: null,
        },
        todos: [{ id: 'saved-todo', title: 'Clear this todo', done: true, createdAt: 0 }],
        settings: { alwaysOnTop: true, quiet: true, reducedMotion: true },
      }),
    );
    const service = new StateService(
      store,
      () => START,
      () => 'test-id',
    );
    await service.initialize();
    await service.dispatch({ type: 'sim.event', event: simulationEvent() });
    await service.dispatch({ type: 'pet.interact' });
    const revision = service.snapshot().state.revision;
    expect(await service.clear()).toMatchObject({ ok: true });
    expect(service.snapshot()).toEqual({
      state: { ...initialState(START), revision: revision + 1 },
      storageError: null,
    });
    expect(await new JsonStore(path).load()).toEqual(persistedState());
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(persistedState());
    expect(await readdir(directory)).toEqual(['state.json']);
    const restarted = new StateService(
      new JsonStore(path),
      () => START + 1_000,
      () => 'restart-id',
    );
    await restarted.initialize();
    expect(durableState(restarted.snapshot().state)).toEqual(persistedState());
    expect(restarted.snapshot().state.simulation.tasks).toEqual([]);
  });

  it('checkpoints a recovered timer on disk and does not advance it again on another launch', async () => {
    const path = join(directory, 'state.json');
    await new JsonStore(path).save(
      persistedState({
        timer: {
          id: 'saved-timer',
          status: 'running',
          durationMs: 60_000,
          remainingMs: 60_000,
          startedAt: START,
        },
      }),
    );
    const first = new StateService(
      new JsonStore(path),
      () => START + 20_000,
      () => 'first-id',
    );
    await first.initialize();
    expect((await new JsonStore(path).load())?.timer).toMatchObject({
      status: 'recovery',
      remainingMs: 40_000,
      startedAt: null,
    });
    const second = new StateService(
      new JsonStore(path),
      () => START + 500_000,
      () => 'second-id',
    );
    await second.initialize();
    expect(second.snapshot().state.timer).toEqual(first.snapshot().state.timer);
    expect(await readdir(directory)).toEqual(['state.json']);
  });
});
