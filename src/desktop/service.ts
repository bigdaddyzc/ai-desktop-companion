import { randomUUID } from 'node:crypto';
import { readPersisted } from '../core/migration';
import { actionSchema, type AppState, type CommandResult, type Snapshot } from '../core/schema';
import { durableState, initialState, reduce, restoreState } from '../core/state';
import type { Persistence } from './store';

export class StateService {
  private state: AppState;
  private storageError: string | null = null;
  private readOnly = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(snapshot: Snapshot) => void>();

  constructor(
    private readonly store: Persistence,
    private readonly clock: () => number,
    private readonly makeId = randomUUID as () => string,
    /** 墙钟时间：与单调时钟对比，用来发现系统休眠或用户改时间。 */
    private readonly wallClock: () => number = Date.now,
  ) {
    this.state = initialState(clock());
  }

  /** 墙钟与单调时钟偏离多少才认定发生了休眠／改时间。 */
  private static readonly clockJumpThresholdMs = 5_000;
  private anchor: { clock: number; wall: number } | null = null;

  /**
   * 单调时钟在系统休眠时会停走，墙钟不会。两者增量相差超过阈值，
   * 说明中途发生过休眠或时间调整；此时不静默补算，交给用户确认。
   */
  private clockJump(now: number, wall: number): number {
    const previous = this.anchor;
    this.anchor = { clock: now, wall };
    if (!previous) return 0;
    const elapsed = now - previous.clock;
    if (elapsed < 200) return 0;
    const drift = wall - previous.wall - elapsed;
    return drift >= StateService.clockJumpThresholdMs ? Math.round(drift) : 0;
  }

  async initialize(): Promise<void> {
    try {
      const saved = await this.store.load();
      if (saved) {
        this.state = restoreState(saved, this.clock());
        // Persist the recovery gate; repeated launches must not keep advancing it.
        if (saved.timer?.status === 'running') await this.store.save(durableState(this.state));
      }
    } catch (error) {
      this.readOnly = true;
      this.storageError = error instanceof Error ? error.message : '无法加载本地数据。';
    }
  }

  snapshot(): Snapshot {
    return { state: structuredClone(this.state), storageError: this.storageError };
  }

  subscribe(listener: (snapshot: Snapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(): void {
    for (const listener of this.listeners) listener(this.snapshot());
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async commit(next: AppState): Promise<CommandResult> {
    const changed = JSON.stringify(durableState(next)) !== JSON.stringify(durableState(this.state));
    if (changed) {
      if (this.readOnly) return { ok: false, error: this.storageError ?? '数据处于只读模式。' };
      try {
        await this.store.save(durableState(next));
        this.storageError = null;
      } catch {
        this.storageError = '保存失败，修改未生效。请检查磁盘空间或文件权限，然后重试。';
        this.publish();
        return { ok: false, error: this.storageError };
      }
    }
    this.state = next;
    this.publish();
    return { ok: true, snapshot: this.snapshot() };
  }

  dispatch(raw: unknown): Promise<CommandResult> {
    return this.serialize(async () => {
      const parsed = actionSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: '无效操作：输入格式或参数超出允许范围。' };
      try {
        return await this.commit(
          reduce(this.state, parsed.data, { now: this.clock(), id: this.makeId() }),
        );
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : '操作未完成。' };
      }
    });
  }

  tick(): Promise<CommandResult> {
    return this.serialize(async () => {
      const now = this.clock();
      const jump = this.clockJump(now, this.wallClock());
      if (jump > 0) {
        return this.commit(
          reduce(this.state, { type: 'timer.clock-jump', jumpMs: jump }, { now, id: '' }),
        );
      }
      return this.commit(reduce(this.state, { type: 'clock.tick' }, { now, id: '' }));
    });
  }

  clear(): Promise<CommandResult> {
    return this.serialize(async () => {
      if (this.readOnly)
        return { ok: false, error: '原数据无法读取，禁止覆盖。请先备份并修复原文件。' };
      const next = initialState(this.clock());
      next.revision = this.state.revision + 1;
      return this.commit(next);
    });
  }

  /** F-13 导入：只接受通过版本校验的数据，覆盖前必须已由主进程弹出原生确认。 */
  import(raw: unknown): Promise<CommandResult> {
    return this.serialize(() => {
      const result = readPersisted(raw);
      if (!result.ok) return Promise.resolve({ ok: false, error: result.error });
      if (this.readOnly) {
        return Promise.resolve({
          ok: false,
          error: '原数据无法读取，禁止覆盖。请先备份并修复原文件。',
        });
      }
      const next = restoreState(result.state, this.clock());
      next.revision = this.state.revision + 1;
      return this.commit(next);
    });
  }

  async settled(): Promise<void> {
    await this.queue;
  }
}
