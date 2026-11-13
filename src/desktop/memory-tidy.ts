import {
  parseTidyPlan,
  shouldSuggestTidy,
  tidyInput,
  tidyLimits,
  type MemoryTidyState,
} from '../core/memory-tidy';
import type { MemoryService } from './memory';

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 120) || '未知错误';
}

export interface TidyModel {
  tidy(input: string): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
}

/**
 * 记忆整理的流程：出方案 → 用户勾选 → 备份后应用 → 可撤销。
 *
 * 模型只给建议，改不改由人定。记忆决定了它怎么看待你，删错一条不会报错，
 * 只会让它以后悟悄换了个态度——所以没有「自动应用」。
 */
export class MemoryTidyService {
  private state: MemoryTidyState = {
    phase: 'idle',
    plan: null,
    error: '',
    notice: '',
    suggest: false,
    canUndo: false,
  };
  private readonly listeners = new Set<(state: MemoryTidyState) => void>();

  constructor(
    private readonly memory: MemoryService,
    private readonly model: TidyModel,
    private readonly now: () => number = Date.now,
  ) {}

  async init(): Promise<void> {
    this.state = {
      ...this.state,
      suggest: shouldSuggestTidy(this.memory.snapshot()),
      canUndo: await this.memory.canUndoTidy(),
    };
    this.memory.subscribe((memory) => {
      const suggest = shouldSuggestTidy(memory);
      if (suggest !== this.state.suggest) this.set({ suggest });
    });
  }

  snapshot(): MemoryTidyState {
    return this.state;
  }

  subscribe(listener: (state: MemoryTidyState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(): Promise<MemoryTidyState> {
    if (this.state.phase === 'thinking') return this.state;
    const memory = this.memory.snapshot();
    if (!memory.enabled) return this.fail('长期记忆已关闭。');
    if (memory.facts.length < tidyLimits.minFacts) {
      return this.set({
        phase: 'idle',
        plan: null,
        error: '',
        notice: `才 ${memory.facts.length} 条，不用整理。`,
      });
    }
    this.set({ phase: 'thinking', plan: null, error: '', notice: '' });
    // 模型层抛异常也得落到 failed，否则面板永远停在「正在通读」且再点不动。
    let result: Awaited<ReturnType<TidyModel['tidy']>>;
    try {
      result = await this.model.tidy(tidyInput(memory));
    } catch (error) {
      return this.fail(`整理失败：${describe(error)}。记忆没动，可以再试一次。`);
    }
    if (!result.ok) return this.fail(result.error);
    // 按发出去的那一版解析：编号对应的是那时的顺序。应用时再按原文核对是否被改过。
    let plan: ReturnType<typeof parseTidyPlan>;
    try {
      plan = parseTidyPlan(result.text, memory, this.now());
    } catch {
      plan = null;
    }
    if (plan === null) return this.fail('没看懂模型给的方案，记忆没动。可以再试一次。');
    if (plan.actions.length === 0) {
      return this.set({ phase: 'idle', plan: null, notice: '看了一遍，没什么需要整理的。' });
    }
    return this.set({ phase: 'ready', plan });
  }

  async apply(actionIds: readonly string[]): Promise<MemoryTidyState> {
    const plan = this.state.plan;
    if (this.state.phase !== 'ready' || plan === null) return this.fail('没有待确认的方案。');
    const ids = actionIds.filter((id) => plan.actions.some((action) => action.id === id));
    if (ids.length === 0) return this.set({ notice: '一条都没勾，没有改动。' });
    let result: Awaited<ReturnType<MemoryService['applyTidy']>>;
    try {
      result = await this.memory.applyTidy(plan, ids);
    } catch (error) {
      return this.fail(`应用失败：${describe(error)}。`);
    }
    if (!result.ok) return this.fail(result.error);
    const staleNote = result.stale > 0 ? `；有 ${result.stale} 项在整理期间被改过，跳过了` : '';
    return this.set({
      phase: 'idle',
      plan: null,
      error: '',
      notice:
        result.applied === 0
          ? `没有改动${staleNote}。`
          : `整理好了：${result.before} 条 → ${result.after} 条${staleNote}。`,
      canUndo: await this.memory.canUndoTidy(),
    });
  }

  discard(): MemoryTidyState {
    return this.set({ phase: 'idle', plan: null, error: '', notice: '' });
  }

  async undo(): Promise<MemoryTidyState> {
    let result: Awaited<ReturnType<MemoryService['undoTidy']>>;
    try {
      result = await this.memory.undoTidy();
    } catch (error) {
      return this.fail(`撤销失败：${describe(error)}。`);
    }
    if (!result.ok) return this.fail(result.error);
    return this.set({
      phase: 'idle',
      plan: null,
      error: '',
      notice: `已撤销上次整理，现在 ${result.count} 条。`,
      canUndo: await this.memory.canUndoTidy(),
    });
  }

  /** 清空记忆后备份也没了：面板上的「撤销」按钮要跟着消失。 */
  async refresh(): Promise<void> {
    this.set({
      suggest: shouldSuggestTidy(this.memory.snapshot()),
      canUndo: await this.memory.canUndoTidy(),
    });
  }

  private fail(error: string): MemoryTidyState {
    // 失败时保留已有方案对应的阶段没意义：统一清掉，用户重新发起。
    return this.set({ phase: 'failed', plan: null, error, notice: '' });
  }

  private set(patch: Partial<MemoryTidyState>): MemoryTidyState {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
    return this.state;
  }
}
