import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readPersisted } from '../core/migration';
import { persistedSchema, type PersistedState } from '../core/schema';

export interface Persistence {
  load(): Promise<PersistedState | null>;
  save(value: PersistedState): Promise<void>;
}

export class JsonStore implements Persistence {
  constructor(private readonly path: string) {}

  async load(): Promise<PersistedState | null> {
    let raw: string;
    try {
      const info = await stat(this.path);
      if (info.size > 2 * 1024 * 1024) {
        throw new Error('数据文件超出允许大小。原文件已保留，当前为只读安全模式。');
      }
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      if (error instanceof Error && error.message.includes('只读安全模式')) throw error;
      throw new Error('本地数据文件无法读取。原文件已保留，当前为只读安全模式。');
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error('本地数据不是有效的 JSON。原文件已保留，当前为只读安全模式。');
    }
    const result = readPersisted(value);
    if (!result.ok) throw new Error(`${result.error} 当前为只读安全模式。`);
    return result.state;
  }

  async save(value: PersistedState): Promise<void> {
    const parsed = persistedSchema.parse(value);
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(parsed, null, 2), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
