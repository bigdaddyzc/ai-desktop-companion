import type { BondMoment } from './bond';
import { hookLimits } from './hook-events';
import type { NudgeEvent } from './proactive';
import type { WorkProgressState } from './progress';

/**
 * 主动开口的事件源：把已有的状态变化翻译成「有件事想跟你说」。
 *
 * 全部是前后两份快照的对比，不新增任何采集；判不准就不说，宁可漏提醒也不谎报。
 */

/** 正在跑的工具是「问用户」一类：这时 agent 在等你，而不是在干活。 */
const waitingTool =
  /(AskUserQuestion|ask_?user|ask_?followup|request_?(user_?)?input|request_?permission|user_?input|approval|confirm)/i;

export function isWaitingTool(name: string): boolean {
  return waitingTool.test(name);
}

export function detectWorkNudges(prev: WorkProgressState, next: WorkProgressState): NudgeEvent[] {
  const events: NudgeEvent[] = [];
  for (const session of next.sessions) {
    const before = prev.sessions.find((item) => item.sessionId === session.sessionId);
    const source = session.source ?? 'WorkBuddy';
    // 装了官方钩子的会话只听钩子的：对方亲口说的，比从工具名和写入间隔里猜准。
    if (session.signal !== undefined) {
      const at = session.signalAt ?? session.updatedAt;
      const changed = before?.signal !== session.signal || before?.signalAt !== session.signalAt;
      const age = next.scannedAt - at;
      if (!changed) continue;
      if (session.signal === 'waiting' && age <= hookLimits.waitingFreshMs) {
        events.push({
          kind: 'agent-waiting',
          key: `waiting:${session.sessionId}:${at}`,
          subject: session.title,
          source,
        });
      } else if (session.signal === 'done' && age <= hookLimits.doneFreshMs) {
        events.push({
          kind: 'agent-stopped',
          key: `stopped:${session.sessionId}:${at}`,
          subject: session.title,
          source,
        });
      }
      continue;
    }
    if (
      isWaitingTool(session.runningTool) &&
      (before === undefined || before.runningTool !== session.runningTool)
    ) {
      events.push({
        kind: 'agent-waiting',
        key: `waiting:${session.sessionId}:${session.updatedAt}`,
        subject: session.title,
        source,
      });
      continue;
    }
    // 只认「刚才还在干、现在停了」这一次跳变；一启动就是 resting 的不算。
    if (before?.status === 'working' && session.status !== 'working') {
      events.push({
        kind: 'agent-stopped',
        key: `stopped:${session.sessionId}:${session.updatedAt}`,
        subject: session.title,
        source,
      });
    }
  }
  return events;
}

export interface DueTodo {
  id: string;
  title: string;
  done: boolean;
  dueAt?: number | null;
}

/** 到点的待办。过期太久（超过 12 小时）的不再提：那是面板里的「已逾期」，不是提醒。 */
export function dueTodoNudges(todos: readonly DueTodo[], now: number): NudgeEvent[] {
  return todos
    .filter(
      (todo) =>
        !todo.done &&
        typeof todo.dueAt === 'number' &&
        todo.dueAt <= now &&
        now - todo.dueAt < 12 * 3_600_000,
    )
    .map((todo) => ({
      kind: 'todo-due' as const,
      key: `due:${todo.id}:${todo.dueAt}`,
      subject: todo.title,
    }));
}

export function momentNudges(
  moments: readonly BondMoment[],
  context: { day: string; openTodos: number },
): NudgeEvent[] {
  return moments.map((moment): NudgeEvent => {
    switch (moment.kind) {
      case 'reunion':
        return { kind: 'reunion', key: `reunion:${context.day}`, days: moment.days };
      case 'morning':
        return {
          kind: 'morning',
          key: `morning:${context.day}`,
          streak: moment.streak,
          todos: context.openTodos,
        };
      case 'evening':
        return {
          kind: 'evening',
          key: `evening:${context.day}`,
          todos: moment.today.todosDone,
          minutes: moment.today.focusMinutes,
          delegated: moment.today.delegated,
        };
      case 'milestone':
        return {
          kind: 'milestone',
          key: `milestone:${moment.key}`,
          ...(moment.days !== undefined ? { days: moment.days } : {}),
          ...(moment.todos !== undefined ? { todos: moment.todos } : {}),
        };
    }
  });
}
