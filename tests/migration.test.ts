import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPersisted } from '../src/core/migration';
import type { PersistedState } from '../src/core/schema';
import { StateService } from '../src/desktop/service';
import { JsonStore, type Persistence } from '../src/desktop/store';

const validV1: PersistedState = {
  version: 1,
  session: { kind: 'idle', title: '自由时光' },
  timer: null,
  todos: [{ id: 't1', title: '导入的待办', done: false, createdAt: 10 }],
  settings: { alwaysOnTop: false, quiet: false, reducedMotion: false },
};

class MemoryStore implements Persistence {
  constructor(public value: PersistedState | null = null) {}
  async load() {
    return this.value;
  }
  async save(value: PersistedState) {
    this.value = value;
  }
}

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe('F-13 数据版本迁移', () => {
  it('接受 v1 数据', () => {
    expect(readPersisted(validV1)).toEqual({ ok: true, state: validV1 });
  });

  it('更高版本明确提示升级，而不是当成损坏数据', () => {
    const result = readPersisted({ ...validV1, version: 2 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('高于当前应用支持');
    expect(result.error).toContain('v2');
    expect(result.error).not.toContain('损坏');
  });

  it('缺少 version、非法旧版本与字段缺失都给出明确原因', () => {
    for (const raw of [
      { todos: [] },
      { ...validV1, version: 0 },
      { ...validV1, version: '1' },
      { ...validV1, todos: [{ id: 'x' }] },
      null,
    ]) {
      expect(readPersisted(raw).ok).toBe(false);
    }
  });

  it('JsonStore 遇到更高版本时抛错且绝不覆盖原文件', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xinban-migrate-'));
    directories.push(directory);
    const path = join(directory, 'state-v1.json');
    const raw = JSON.stringify({ ...validV1, version: 3 });
    await writeFile(path, raw, 'utf8');
    await expect(new JsonStore(path).load()).rejects.toThrow(/高于当前应用支持/);
    expect(await readFile(path, 'utf8')).toBe(raw);
  });

  it('JsonStore 遇到损坏 JSON 时抛错且保留原件', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xinban-migrate-'));
    directories.push(directory);
    const path = join(directory, 'state-v1.json');
    const raw = '{broken';
    await writeFile(path, raw, 'utf8');
    await expect(new JsonStore(path).load()).rejects.toThrow(/只读安全模式/);
    expect(await readFile(path, 'utf8')).toBe(raw);
  });
});

describe('F-13 导入个人数据', () => {
  it('导入合法 v1 后状态与持久化同步更新', async () => {
    const store = new MemoryStore();
    const service = new StateService(
      store,
      () => 5_000,
      () => 'imported',
    );
    await service.initialize();
    const result = await service.import(validV1);
    expect(result.ok).toBe(true);
    expect(service.snapshot().state.todos).toHaveLength(1);
    expect(store.value?.todos[0]?.title).toBe('导入的待办');
  });

  it('拒绝更高版本与损坏数据，且不改动现有状态', async () => {
    const store = new MemoryStore(validV1);
    const service = new StateService(
      store,
      () => 5_000,
      () => 'x',
    );
    await service.initialize();
    const before = service.snapshot().state.todos;
    for (const raw of [{ ...validV1, version: 4 }, { broken: true }]) {
      const result = await service.import(raw);
      expect(result.ok).toBe(false);
    }
    expect(service.snapshot().state.todos).toEqual(before);
  });

  it('导入运行中的计时会进入等待恢复，不自动续跑', async () => {
    const store = new MemoryStore();
    const service = new StateService(
      store,
      () => 5_000,
      () => 'x',
    );
    await service.initialize();
    const running: PersistedState = {
      ...validV1,
      timer: {
        id: 'timer-1',
        status: 'running',
        durationMs: 60_000,
        remainingMs: 60_000,
        startedAt: 1_000,
      },
    };
    expect((await service.import(running)).ok).toBe(true);
    expect(service.snapshot().state.timer?.status).toBe('recovery');
  });
});
