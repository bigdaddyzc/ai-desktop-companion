import type { ButtonId, Gesture } from './input';

/**
 * 手势 → 意图。桌面按钮和实体按键共用这一张表。
 *
 * 优先级就是「屏上此刻最该被回应的东西」：
 * 1. 它在等你确认一个动作（跑命令/看屏幕/派活）→ A 允许，B 拒绝；
 * 2. 它主动跟你说了一句 → A 接（细说/好），B 知道了；
 * 3. 模拟任务在等确认 → A 确认；
 * 4. 否则 A 摸摸、B 小游戏；B 长按始终是勿扰。
 *
 * 游戏状态只在桌面端，由调用方在拿到 interact / game-toggle 后自行处理。
 */

export type GestureIntent =
  | { type: 'confirm-answer'; id: string; allow: boolean }
  | { type: 'nudge-answer'; id: string; accept: boolean }
  | { type: 'sim-ack'; taskId: string }
  | { type: 'timer-recovery-hint' }
  | { type: 'interact' }
  | { type: 'game-toggle' }
  | { type: 'quiet-toggle' }
  | { type: 'unassigned'; button: ButtonId; gesture: Gesture };

export interface GestureContext {
  confirmId: string | null;
  nudgeId: string | null;
  waitingTaskId: string | null;
  timerRecovery: boolean;
}

export function intentFor(
  context: GestureContext,
  button: ButtonId,
  gesture: Gesture,
): GestureIntent {
  if (button === 'B' && gesture === 'long') return { type: 'quiet-toggle' };
  if (gesture === 'long') return { type: 'unassigned', button, gesture };
  if (context.confirmId !== null) {
    return { type: 'confirm-answer', id: context.confirmId, allow: button === 'A' };
  }
  if (context.nudgeId !== null) {
    return { type: 'nudge-answer', id: context.nudgeId, accept: button === 'A' };
  }
  if (button === 'A') {
    if (context.waitingTaskId !== null) return { type: 'sim-ack', taskId: context.waitingTaskId };
    if (context.timerRecovery) return { type: 'timer-recovery-hint' };
    return { type: 'interact' };
  }
  return { type: 'game-toggle' };
}
