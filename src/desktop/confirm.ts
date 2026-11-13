import { remoteApproveLimits } from '../core/agent-permission';
import {
  confirmLimits,
  emptyConfirm,
  needsFullScreen,
  type ConfirmOutcome,
  type ConfirmRecord,
  type ConfirmRequest,
  type ConfirmSnapshot,
  type PendingConfirm,
} from '../core/confirm';

interface Waiter {
  pending: PendingConfirm;
  resolve(outcome: ConfirmOutcome): void;
  timer: ReturnType<typeof setTimeout> | null;
  cleanup(): void;
}

function isExternal(waiter: Waiter): boolean {
  return waiter.pending.external !== undefined;
}

/**
 * 确认的唯一持有者。
 *
 * 工具要动手时调 request()，拿到一个等用户回答的 Promise。
 * 桌宠 A/B、面板按钮、实体按键都只是调 answer()——入口再多，判定只有这一处。
 * 同一时刻只亮一条，其余排队；对话被取消时，属于它的等待一并作废。
 *
 * 外部 Agent 的请求走 requestExternal()：另计队列上限，过期时间是钩子的截止时间
 * （排队时也在走，因为对方进程确实在等），过期算「交回终端」而不是拒绝。
 */
export class ConfirmService {
  private readonly waiters: Waiter[] = [];
  private recent: ConfirmRecord[] = [];
  private readonly listeners = new Set<(snapshot: ConfirmSnapshot) => void>();
  private sequence = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly timeoutMs: number = confirmLimits.timeoutMs,
  ) {}

  snapshot(): ConfirmSnapshot {
    if (this.waiters.length === 0 && this.recent.length === 0) return emptyConfirm();
    return {
      pending: this.waiters[0]?.pending ?? null,
      queued: Math.max(0, this.waiters.length - 1),
      recent: this.recent,
    };
  }

  subscribe(listener: (snapshot: ConfirmSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  request(request: ConfirmRequest, signal?: AbortSignal): Promise<boolean> {
    const own: ConfirmRequest = {
      tool: request.tool,
      title: request.title,
      detail: request.detail,
    };
    return this.enqueue(own, null, signal).outcome.then((outcome) => outcome === 'allowed');
  }

  /**
   * 外部 Agent 的权限请求。deadline 是钩子放弃等待的时刻。
   * 结果：allowed / remembered / denied / deferred（交回、超时、排队满）/ cancelled（钩子已走、芯伴退出）。
   * 返回卡片 id：钩子进程没了时用 dismiss(id) 撤卡。
   */
  requestExternal(
    request: ConfirmRequest & { external: { canRemember: boolean } },
    deadline: number,
  ): { id: string; outcome: Promise<ConfirmOutcome> } {
    return this.enqueue(request, deadline);
  }

  private enqueue(
    request: ConfirmRequest,
    deadline: number | null,
    signal?: AbortSignal,
  ): { id: string; outcome: Promise<ConfirmOutcome> } {
    const now = this.now();
    this.sequence += 1;
    const external = deadline !== null;
    const pending: PendingConfirm = {
      ...request,
      id: `c${now.toString(36)}${this.sequence.toString(36)}`,
      createdAt: now,
      expiresAt: external ? deadline : now + this.timeoutMs,
    };
    const id = pending.id;
    if (signal?.aborted) return { id, outcome: Promise.resolve('cancelled') };
    const same = this.waiters.filter((waiter) => isExternal(waiter) === external).length;
    const limit = external ? remoteApproveLimits.queue : confirmLimits.queue;
    if (same >= limit || (external && deadline <= now)) {
      // 模型一口气要问十次：多出来的拒掉；外部的交回终端。
      const outcome: ConfirmOutcome = external ? 'deferred' : 'denied';
      this.record(pending, outcome);
      this.publish();
      return { id, outcome: Promise.resolve(outcome) };
    }
    const outcome = new Promise<ConfirmOutcome>((resolve) => {
      const onAbort = (): void => {
        this.settle(pending.id, 'cancelled');
      };
      const waiter: Waiter = {
        pending,
        resolve,
        timer: null,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
      if (external) {
        // 对方进程的等待已经在走：排队与否都从现在开始计时。
        waiter.timer = setTimeout(
          () => this.settle(pending.id, 'deferred'),
          Math.max(0, deadline - now),
        );
        waiter.timer.unref?.();
      }
      // 芯伴自己的工具只给排在最前面的那条计时：排队的还没亮出来，不该在用户看不见时过期。
      this.armHead();
      this.publish();
    });
    return { id, outcome };
  }

  /** 用户回答。id 不对（已经过期、或者是旧卡片）时忽略，返回 false。 */
  answer(id: string, allow: boolean): boolean {
    if (typeof id !== 'string' || typeof allow !== 'boolean') return false;
    return this.settle(id, allow ? 'allowed' : 'denied');
  }

  /**
   * 外部请求的另两个按钮。「以后同类都批」只在卡片本身允许时生效（高风险的没有这个按钮）。
   */
  answerExternal(id: string, action: 'defer' | 'remember'): boolean {
    const waiter = this.waiters.find((item) => item.pending.id === id);
    const external = waiter?.pending.external;
    if (!waiter || external === undefined) return false;
    if (action === 'remember') {
      if (!external.canRemember) return false;
      return this.settle(id, 'remembered');
    }
    return this.settle(id, 'deferred');
  }

  /** 钩子已经不等了（进程没了、pending 文件被删）：撤卡。 */
  dismiss(id: string): boolean {
    return this.settle(id, 'cancelled');
  }

  /** 远程批准被关掉：挂着的外部请求全部交回终端。 */
  deferAllExternal(): void {
    for (const waiter of this.waiters.filter(isExternal))
      this.settle(waiter.pending.id, 'deferred');
  }

  /**
   * 实体小屏上的回答。小屏放不下全文时只接受「拒绝」：你只看到了半条命令，
   * 按 A 不算数，要去面板或桌宠上看全了再点。
   */
  answerFromDevice(id: string, allow: boolean): boolean {
    const waiter = this.waiters.find((item) => item.pending.id === id);
    if (waiter && allow && needsFullScreen(waiter.pending)) return false;
    return this.answer(id, allow);
  }

  /** 回答当前亮着的那条：实体按键不知道 id，只知道「屏上那个」。 */
  answerCurrent(allow: boolean): boolean {
    const head = this.waiters[0];
    if (!head) return false;
    return this.answerFromDevice(head.pending.id, allow);
  }

  /** 退出或对话整体取消时把所有等待一并拒掉。 */
  cancelAll(): void {
    for (const waiter of [...this.waiters]) this.settle(waiter.pending.id, 'cancelled');
  }

  private settle(id: string, outcome: ConfirmOutcome): boolean {
    const index = this.waiters.findIndex((waiter) => waiter.pending.id === id);
    if (index < 0) return false;
    const [waiter] = this.waiters.splice(index, 1);
    if (!waiter) return false;
    if (waiter.timer !== null) clearTimeout(waiter.timer);
    waiter.cleanup();
    this.record(waiter.pending, outcome);
    waiter.resolve(outcome);
    this.armHead();
    this.publish();
    return true;
  }

  private armHead(): void {
    const head = this.waiters[0];
    if (!head || head.timer !== null || isExternal(head)) return;
    // 排队的那条轮到自己时才开始计时，过期时间也从这一刻算。
    const now = this.now();
    head.pending = { ...head.pending, expiresAt: now + this.timeoutMs };
    head.timer = setTimeout(() => this.settle(head.pending.id, 'expired'), this.timeoutMs);
    head.timer.unref?.();
  }

  private record(pending: PendingConfirm, outcome: ConfirmOutcome): void {
    this.recent = [
      {
        id: pending.id,
        tool: pending.tool,
        title: pending.title,
        detail: pending.detail,
        outcome,
        at: this.now(),
      },
      ...this.recent,
    ].slice(0, confirmLimits.recent);
  }

  private publish(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
