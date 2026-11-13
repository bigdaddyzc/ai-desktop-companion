import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  approvalLimits,
  learnApprovals,
  normalizeApproval,
  parseApprovalEvents,
  recentAutoApprovals,
  revokeApproval,
  sameGrant,
  type ApprovalGrant,
  type ApprovalSource,
  type ApprovalState,
  type ApprovalView,
  type AutoApproval,
} from '../core/auto-approve';
import { writeJsonAtomic, writeTextAtomic } from './atomic';

/**
 * 「替你确认」的桌面侧：主进程是 approve.json 的唯一写入者。
 *
 * 钩子脚本只读两样东西：approve.json（开关 + 你批过什么）和 alive（心跳）。
 * 芯伴退出时删掉 alive，崩溃时心跳自然过期——两种情况钩子都不再替你批。
 */
export class ApprovalStore {
  private state: ApprovalState = normalizeApproval(undefined);
  private recent: AutoApproval[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    /** userData/hooks：和钩子脚本同目录，脚本用 __dirname 找到它们。 */
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private get statePath(): string {
    return join(this.dir, 'approve.json');
  }

  private get alivePath(): string {
    return join(this.dir, 'alive');
  }

  async load(): Promise<void> {
    let raw = '';
    try {
      raw = await readFile(this.statePath, 'utf8');
      this.state = normalizeApproval(JSON.parse(raw));
    } catch {
      this.state = normalizeApproval(undefined);
    }
    // 文件和规范化结果不一致（旧修订号被安全重置、被手改、坏了）：当场写回，
    // 钩子只读文件，不写回就还会按旧授权替你批。
    if (raw !== '' && raw.trim() !== JSON.stringify(this.state)) {
      try {
        await mkdir(this.dir, { recursive: true });
        await writeJsonAtomic(this.statePath, this.state);
      } catch {
        // 写不了：钩子 v4 自己也不认旧修订号的文件。
      }
    }
  }

  view(): ApprovalView {
    return { enabled: this.state.enabled, grants: [...this.state.grants], recent: this.recent };
  }

  /** 所有写入排队：学习、开关、撤销可能同时发生。 */
  private commit(next: (state: ApprovalState) => ApprovalState): Promise<void> {
    const run = async (): Promise<void> => {
      const updated = next(this.state);
      if (updated === this.state) return;
      this.state = updated;
      await mkdir(this.dir, { recursive: true });
      await writeJsonAtomic(this.statePath, updated);
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  setEnabled(enabled: boolean): Promise<void> {
    return this.commit((state) => (state.enabled === enabled ? state : { ...state, enabled }));
  }

  /**
   * 远程批准卡上的「以后同类都批」：你亲手点的，等同于在对方弹窗里批过一次并打开替你确认。
   * 高风险的请求卡上没有这个按钮（keys 为空或 risk 非空，见 agent-permission.ts）。
   */
  remember(source: ApprovalSource, project: string, keys: readonly string[]): Promise<void> {
    return this.commit((state) => {
      const grants = [...state.grants];
      for (const key of keys) {
        const grant = { source, project, key, at: this.now() };
        if (!grants.some((g) => sameGrant(g, grant))) grants.push(grant);
      }
      return { ...state, enabled: true, grants: grants.slice(-approvalLimits.maxGrants) };
    });
  }

  revoke(target: Pick<ApprovalGrant, 'source' | 'project' | 'key'>): Promise<void> {
    return this.commit((state) => revokeApproval(state, target));
  }

  /** 收件箱内容变了就调一次：学新的批准，刷新「最近替你批的」。 */
  learn(inboxText: string): Promise<void> {
    const events = parseApprovalEvents(inboxText);
    this.recent = recentAutoApprovals(events);
    return this.commit((state) => learnApprovals(state, events));
  }

  private async beat(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      await writeTextAtomic(this.alivePath, String(this.now()));
    } catch {
      // 写不了心跳：钩子会当芯伴没开，照常问你——安全的一侧。
    }
  }

  start(): void {
    void this.beat();
    this.timer = setInterval(() => void this.beat(), approvalLimits.heartbeatMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await rm(this.alivePath, { force: true }).catch(() => undefined);
  }
}
