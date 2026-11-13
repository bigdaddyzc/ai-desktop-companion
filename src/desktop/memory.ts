import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { applyTidyPlan, type TidyPlan } from '../core/memory-tidy';
import {
  addEpisode,
  buildMemoryInjection,
  emptyMemory,
  forgetFacts,
  mergeFact,
  normalizeMemoryText,
  searchFacts,
  trimFacts,
  memoryLimits,
  type MemoryExtraction,
  type MemoryFact,
  type MemoryState,
} from '../core/memory';
import { writeJsonAtomic } from './atomic';

/**
 * 长期记忆的持久化与服务层。
 *
 * 数据只在这台机器上：`memory-v1.json`，原子写、0o600、不导出、不进日志。
 * 什么时候会离开本机？只有你发消息时——被挑中的几条会随 instructions 一起发给
 * DeepSeek，否则模型不知道自己记得什么。面板里写明了这一点。
 */

const factSchema = z
  .object({
    id: z.string().min(1).max(64),
    text: z.string().min(1).max(memoryLimits.factChars),
    category: z.enum(['identity', 'preference', 'habit', 'goal', 'relation', 'context']),
    source: z.enum(['said', 'inferred']),
    createdAt: z.number().finite().nonnegative(),
    updatedAt: z.number().finite().nonnegative(),
    hits: z.number().int().nonnegative(),
    pinned: z.boolean(),
  })
  .strict();

const episodeSchema = z
  .object({
    id: z.string().min(1).max(64),
    at: z.number().finite().nonnegative(),
    summary: z.string().min(1).max(memoryLimits.episodeChars),
  })
  .strict();

const storedSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    facts: z.array(factSchema).max(1_000),
    episodes: z.array(episodeSchema).max(500),
    tidiedAt: z.number().finite().nonnegative().optional(),
    tidiedCount: z.number().int().nonnegative().optional(),
  })
  .strict();

export class MemoryStore {
  constructor(private readonly path: string) {}

  /**
   * 读取记忆。
   * 文件不存在、损坏或版本不认识都按「还没有记忆」处理——
   * 记忆丢了不该让应用起不来，原文件也不会被立刻覆盖。
   */
  async load(): Promise<MemoryState> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      return emptyMemory();
    }
    try {
      const parsed = storedSchema.parse(JSON.parse(raw));
      return { ...parsed, facts: trimFacts({ ...parsed }).facts };
    } catch {
      return emptyMemory();
    }
  }

  async save(state: MemoryState): Promise<void> {
    await writeJsonAtomic(this.path, storedSchema.parse(state));
  }

  /** 整理前的快照放在同目录的 memory-backups 里，只留最近几份。 */
  private get backupDir(): string {
    return join(dirname(this.path), 'memory-backups');
  }

  static readonly keepBackups = 10;

  async backup(state: MemoryState, at: number): Promise<void> {
    await mkdir(this.backupDir, { recursive: true });
    await writeJsonAtomic(join(this.backupDir, `memory-${at}.json`), storedSchema.parse(state));
    const names = await this.backupNames();
    for (const name of names.slice(MemoryStore.keepBackups)) {
      await rm(join(this.backupDir, name), { force: true });
    }
  }

  /** 新的在前。文件名里的数字就是备份时间。 */
  private async backupNames(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.backupDir);
    } catch {
      return [];
    }
    return names
      .filter((name) => /^memory-\d+\.json$/.test(name))
      .sort((a, b) => Number(b.slice(7, -5)) - Number(a.slice(7, -5)));
  }

  async latestBackup(): Promise<{ name: string; at: number; state: MemoryState } | null> {
    for (const name of await this.backupNames()) {
      try {
        const raw = await readFile(join(this.backupDir, name), 'utf8');
        return { name, at: Number(name.slice(7, -5)), state: storedSchema.parse(JSON.parse(raw)) };
      } catch {
        // 坏掉的备份跳过，继续找更早的一份。
      }
    }
    return null;
  }

  async dropBackup(name: string): Promise<void> {
    await rm(join(this.backupDir, name), { force: true });
  }

  /** 清空记忆时一起删：用户说「全忘掉」，备份里也不该还留着。 */
  async clearBackups(): Promise<void> {
    await rm(this.backupDir, { recursive: true, force: true });
  }
}

export interface RememberResult {
  ok: boolean;
  /** 给模型看的结果文字。 */
  output: string;
  /** 给界面看的一行摘要。 */
  note: string;
  text: string;
}

export interface MemoryInjectionStats {
  turns: number;
  injectedTurns: number;
  injectedFacts: number;
  matchedFacts: number;
  last: { injected: number; matched: number } | null;
}

export class MemoryService {
  private state: MemoryState = emptyMemory();
  private readonly listeners = new Set<(state: MemoryState) => void>();

  constructor(
    private readonly store: MemoryStore,
    private readonly now: () => number = Date.now,
  ) {}

  async init(): Promise<void> {
    this.state = await this.store.load();
  }

  snapshot(): MemoryState {
    return this.state;
  }

  /** 面板订阅记忆变化：后台抽取写完一条，界面不用手动刷新就能看到。 */
  subscribe(listener: (state: MemoryState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 记忆关闭时返回空串：不注入 = 模型看不见，和「有没有存」是两件事。 */
  promptFor(query: string): string {
    const injection = buildMemoryInjection(this.state, query);
    if (this.state.enabled) {
      this.injection = {
        turns: this.injection.turns + 1,
        injectedTurns: this.injection.injectedTurns + (injection.injected.length > 0 ? 1 : 0),
        injectedFacts: this.injection.injectedFacts + injection.injected.length,
        matchedFacts: this.injection.matchedFacts + injection.matched,
        last: { injected: injection.injected.length, matched: injection.matched },
      };
    }
    return injection.text;
  }

  /**
   * 本次运行的注入统计：精度 = matchedFacts / injectedFacts。
   * 只在内存里；写进运行日志的是每轮的条数，不是内容。
   */
  injectionStats(): MemoryInjectionStats {
    return this.injection;
  }

  private injection: MemoryInjectionStats = {
    turns: 0,
    injectedTurns: 0,
    injectedFacts: 0,
    matchedFacts: 0,
    last: null,
  };

  async remember(
    rawText: string,
    rawCategory?: unknown,
    source: 'said' | 'inferred' = 'said',
  ): Promise<RememberResult> {
    const text = normalizeMemoryText(rawText);
    if (text.length < 2) {
      return { ok: false, output: '这条内容太短，没有记录。', note: '内容为空', text: '' };
    }
    const { state, outcome, fact } = mergeFact(
      this.state,
      {
        text,
        category: typeof rawCategory === 'string' ? rawCategory : undefined,
        source,
      },
      this.now(),
    );
    if (outcome === 'skipped' || fact === null) {
      return { ok: false, output: '这条内容没有记录。', note: '未记录', text: '' };
    }
    this.state = state;
    const saved = await this.persist();
    if (!saved) {
      return {
        ok: false,
        output: '记忆写入失败，这次没有保存。',
        note: '写入失败',
        text: fact.text,
      };
    }
    return {
      ok: true,
      output: outcome === 'added' ? `已记住：${fact.text}` : `已更新这条记忆：${fact.text}`,
      note: outcome === 'added' ? '已记住' : '已更新',
      text: fact.text,
    };
  }

  /**
   * 按描述忘掉。命中太多时不删，把候选交回去——「忘掉长沙」不该一口气清掉五条。
   */
  async forget(query: string): Promise<{ removed: string[]; candidates: string[] }> {
    const { state, removed, candidates } = forgetFacts(this.state, query);
    if (removed.length === 0) {
      return { removed: [], candidates: candidates.map((fact) => fact.text) };
    }
    this.state = state;
    await this.persist();
    return { removed: removed.map((fact) => fact.text), candidates: [] };
  }

  search(query: string, limit = 6): MemoryFact[] {
    return searchFacts(this.state, query, limit);
  }

  async remove(id: string): Promise<boolean> {
    const before = this.state.facts.length;
    this.state = { ...this.state, facts: this.state.facts.filter((fact) => fact.id !== id) };
    if (this.state.facts.length === before) return false;
    await this.persist();
    return true;
  }

  /**
   * 记忆「世代」：清空或关闭时 +1。后台抽取发出前记下世代，落地时世代变了就丢弃——
   * 否则刚清空，飞在半路的抽取又把清空前那段对话写回来。
   */
  private gen = 0;

  generation(): number {
    return this.gen;
  }

  async clear(): Promise<void> {
    this.gen += 1;
    this.state = {
      ...this.state,
      facts: [],
      episodes: [],
      tidiedAt: undefined,
      tidiedCount: undefined,
    };
    await this.persist();
    await this.store.clearBackups().catch(() => undefined);
  }

  /** 总开关。关闭后不再注入、不再抽取，记忆工具也会从工具表里撤掉。 */
  async setEnabled(enabled: boolean): Promise<void> {
    if (this.state.enabled === enabled) return;
    if (!enabled) this.gen += 1;
    this.state = { ...this.state, enabled };
    await this.persist();
  }

  /**
   * 应用整理方案里用户勾选的动作。
   * 先备份再改：备份写不进去就不动记忆——整理删错了必须还能撤回来。
   */
  async applyTidy(
    plan: TidyPlan,
    actionIds: readonly string[],
  ): Promise<
    | { ok: true; applied: number; stale: number; before: number; after: number }
    | { ok: false; error: string }
  > {
    const now = this.now();
    const before = this.state.facts.length;
    const outcome = applyTidyPlan(this.state, plan, actionIds, now);
    if (outcome.applied === 0) {
      return { ok: true, applied: 0, stale: outcome.stale, before, after: before };
    }
    try {
      await this.writes;
      await this.store.backup(this.state, now);
    } catch {
      return { ok: false, error: '备份写不进去，这次没有改动任何记忆。' };
    }
    // 备份期间后台可能又写进了新记忆：在最新状态上重算一遍，不拿旧结果覆盖。
    const fresh = applyTidyPlan(this.state, plan, actionIds, now);
    this.state = { ...fresh.state, tidiedAt: now, tidiedCount: fresh.state.facts.length };
    const saved = await this.persist();
    if (!saved) return { ok: false, error: '整理结果没写进文件，重启后会回到整理前。' };
    return {
      ok: true,
      applied: fresh.applied,
      stale: fresh.stale,
      before,
      after: this.state.facts.length,
    };
  }

  async canUndoTidy(): Promise<boolean> {
    return (await this.store.latestBackup()) !== null;
  }

  /**
   * 撤销上一次整理：回到整理前的事实。
   * 整理之后新记下的保留；纪要、开关用当前的，整理本来就没动它们。
   */
  async undoTidy(): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
    await this.writes;
    const backup = await this.store.latestBackup();
    if (!backup) return { ok: false, error: '没有可以撤销的整理。' };
    const known = new Set(backup.state.facts.map((fact) => fact.id));
    const later = this.state.facts.filter(
      (fact) => !known.has(fact.id) && fact.createdAt > backup.at,
    );
    this.state = {
      ...this.state,
      facts: trimFacts({ ...this.state, facts: [...backup.state.facts, ...later] }).facts,
      tidiedAt: backup.state.tidiedAt,
      tidiedCount: backup.state.tidiedCount,
    };
    const saved = await this.persist();
    if (!saved) return { ok: false, error: '撤销没写进文件。' };
    await this.store.dropBackup(backup.name);
    return { ok: true, count: this.state.facts.length };
  }

  /** 后台抽取的落地：事实走合并去重，纪要只留一句。 */
  async applyExtraction(
    extraction: MemoryExtraction,
    /** 发起抽取时的 generation()；期间被清空/关闭过就不写。 */
    since?: number,
  ): Promise<{ facts: number; episode: boolean }> {
    if (!this.state.enabled) return { facts: 0, episode: false };
    if (since !== undefined && since !== this.gen) return { facts: 0, episode: false };
    let state = this.state;
    let changed = 0;
    for (const item of extraction.facts) {
      const merged = mergeFact(state, { ...item, source: 'inferred' }, this.now());
      if (merged.outcome === 'skipped') continue;
      state = merged.state;
      changed += 1;
    }
    let episode = false;
    if (extraction.episode !== '') {
      const added = addEpisode(state, extraction.episode, this.now());
      state = added.state;
      episode = added.added;
    }
    if (changed === 0 && !episode) return { facts: 0, episode: false };
    this.state = state;
    await this.persist();
    return { facts: changed, episode };
  }

  /**
   * 串行写盘。后台抽取、工具写入、面板删除可能同时发生；各自并发 rename 时
   * 谁后落地不确定，旧状态可能盖掉新状态（「删掉的记忆复活」）。
   * 排队后每次写的都是执行那一刻的最新状态，最后一次写入一定是最新的。
   */
  private writes: Promise<unknown> = Promise.resolve();

  private persist(): Promise<boolean> {
    const run = this.writes.then(async () => {
      const state = this.state;
      try {
        await this.store.save(state);
        for (const listener of this.listeners) listener(state);
        return true;
      } catch {
        // 落盘失败不回滚内存：本次运行里它还记得，只是重启会丢。
        return false;
      }
    });
    this.writes = run;
    return run;
  }

  /** 等所有排队中的写盘完成：退出前调用，避免最后一条记忆没落盘。 */
  async settled(): Promise<void> {
    await this.writes;
  }
}
