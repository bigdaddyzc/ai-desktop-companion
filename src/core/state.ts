import {
  persistedSchema,
  sessionLabels,
  terminalStatuses,
  type AppState,
  type InternalAction,
  type PersistedState,
  type SimulationEvent,
  type Timer,
} from './schema';
import { builtInIdleLines } from './persona';

export function initialState(now: number): AppState {
  return {
    version: 1,
    revision: 0,
    now,
    session: { kind: 'idle', title: sessionLabels.idle },
    timer: null,
    todos: [],
    settings: { alwaysOnTop: false, quiet: false, reducedMotion: false },
    simulation: { connected: true, tasks: [], seenIds: [], journal: [], events: [] },
    petUntil: 0,
  };
}

export function durableState(state: AppState): PersistedState {
  return {
    version: 1,
    session: state.session,
    timer: state.timer,
    todos: state.todos,
    settings: state.settings,
  };
}

export function remainingMs(timer: Timer | null, now: number): number {
  if (!timer) return 0;
  return Math.max(
    0,
    timer.remainingMs - (timer.startedAt === null ? 0 : Math.max(0, now - timer.startedAt)),
  );
}

export function restoreState(raw: unknown, now: number): AppState {
  const persisted = persistedSchema.parse(raw);
  let timer = persisted.timer;
  if (timer?.status === 'running') {
    timer = {
      ...timer,
      status: 'recovery',
      remainingMs: remainingMs(timer, now),
      startedAt: null,
      recoveryReason: 'restart',
    };
  }
  return { ...initialState(now), ...persisted, timer };
}

function journal(state: AppState, line: string): AppState {
  return {
    ...state,
    simulation: { ...state.simulation, journal: [line, ...state.simulation.journal].slice(0, 40) },
  };
}

function ingest(state: AppState, event: SimulationEvent, now: number): AppState {
  // F-12：先记录到达的原始事件（含被忽略的），回放脚本才能复现完整序列。
  const observed: AppState = {
    ...state,
    simulation: {
      ...state.simulation,
      events: [...state.simulation.events, event].slice(-30),
    },
  };
  if (!observed.simulation.connected)
    return journal(observed, '离线：丢弃模拟事件，重连后需重新同步。');
  if (observed.simulation.seenIds.includes(event.eventId))
    return journal(observed, '已忽略重复事件。');
  const previous = observed.simulation.tasks.find((task) => task.id === event.taskId);
  const seenIds = [...observed.simulation.seenIds, event.eventId].slice(-512);
  const marked = { ...observed, simulation: { ...observed.simulation, seenIds } };
  if (previous && event.sequence <= previous.sequence)
    return journal(marked, '已忽略乱序／过期事件。');
  if (previous && terminalStatuses.includes(previous.status)) {
    return journal(marked, '已忽略终态变更：重试必须创建新的任务 ID。');
  }
  const task = {
    id: event.taskId,
    title: event.title,
    status: event.status,
    sequence: event.sequence,
    progress: event.progress,
    updatedAt: now,
  };
  return journal(
    {
      ...marked,
      simulation: {
        ...marked.simulation,
        tasks: [task, ...observed.simulation.tasks.filter((item) => item.id !== task.id)].slice(
          0,
          30,
        ),
      },
    },
    `${event.title} → ${event.status} · seq ${event.sequence}`,
  );
}

export function reduce(
  state: AppState,
  action: InternalAction,
  context: { now: number; id: string },
): AppState {
  const now = Math.max(state.now, context.now);
  let next = { ...state, now, revision: state.revision + 1 };
  // Arrival of any command must also settle an elapsed timer —
  // except a clock jump: the jump itself is what made the timer look elapsed,
  // so it goes to recovery and the user decides, instead of silently completing.
  if (
    action.type !== 'timer.clock-jump' &&
    next.timer?.status === 'running' &&
    remainingMs(next.timer, now) === 0
  ) {
    next = {
      ...next,
      timer: { ...next.timer, status: 'completed', startedAt: null, remainingMs: 0 },
    };
  }
  switch (action.type) {
    case 'session.set':
      return { ...next, session: { kind: action.kind, title: action.title } };
    case 'todo.add':
      if (state.todos.length >= 1_000) throw new Error('待办上限为 1000 条，请先清理或导出。');
      return {
        ...next,
        todos: [
          {
            id: context.id,
            title: action.title,
            done: false,
            createdAt: now,
            ...(action.dueAt !== undefined ? { dueAt: action.dueAt } : {}),
          },
          ...state.todos,
        ],
      };
    case 'todo.due':
      return {
        ...next,
        todos: state.todos.map((todo) => {
          if (todo.id !== action.id) return todo;
          if (action.dueAt === null) {
            const { dueAt: _removed, ...rest } = todo;
            return rest;
          }
          return { ...todo, dueAt: action.dueAt };
        }),
      };
    case 'todo.toggle':
      return {
        ...next,
        todos: state.todos.map((todo) =>
          todo.id === action.id ? { ...todo, done: !todo.done } : todo,
        ),
      };
    case 'todo.remove':
      return { ...next, todos: state.todos.filter((todo) => todo.id !== action.id) };
    case 'timer.start':
      if (next.timer && next.timer.status !== 'completed') throw new Error('请先结束当前计时。');
      return {
        ...next,
        timer: {
          id: context.id,
          status: 'running',
          durationMs: action.minutes * 60_000,
          remainingMs: action.minutes * 60_000,
          startedAt: now,
        },
      };
    case 'timer.pause':
      if (next.timer?.status !== 'running') return next;
      return {
        ...next,
        timer: {
          ...next.timer,
          status: 'paused',
          remainingMs: remainingMs(next.timer, now),
          startedAt: null,
        },
      };
    case 'timer.resume':
      if (!next.timer || !['paused', 'recovery'].includes(next.timer.status)) return next;
      return {
        ...next,
        timer: {
          ...next.timer,
          status: next.timer.remainingMs === 0 ? 'completed' : 'running',
          startedAt: next.timer.remainingMs === 0 ? null : now,
          recoveryReason: undefined,
        },
      };
    /**
     * 运行期检测到系统休眠或时间跳变。不用墙钟时间静默补算剩余量——
     * 睡眠期间计时是否该继续，只有用户知道，因此转为待确认并保留当前剩余量。
     */
    case 'timer.clock-jump':
      if (next.timer?.status !== 'running') return next;
      return {
        ...next,
        timer: {
          ...next.timer,
          status: 'recovery',
          remainingMs: remainingMs(next.timer, now),
          startedAt: null,
          recoveryReason: 'clock-jump',
        },
      };
    case 'timer.cancel':
      return { ...next, timer: null };
    case 'settings.patch':
      return { ...next, settings: { ...next.settings, ...action.patch } };
    case 'pet.interact':
      return { ...next, petUntil: now + 4_000 };
    case 'sim.connect':
      return journal(
        {
          ...next,
          simulation: {
            ...next.simulation,
            connected: action.connected,
            tasks: action.connected && !next.simulation.connected ? [] : next.simulation.tasks,
          },
        },
        action.connected
          ? '模拟连接已恢复；旧记录仅作回放，请新建任务。'
          : '模拟连接断开；已有任务状态待确认。',
      );
    case 'sim.event':
      return ingest(next, action.event, now);
    case 'sim.script':
      return action.events.reduce((current, event) => ingest(current, event, now), next);
    case 'sim.acknowledge': {
      const task = next.simulation.tasks.find((item) => item.id === action.taskId);
      if (!task || task.status !== 'waiting')
        return journal(next, '确认已忽略：没有等待中的该任务。');
      // 不推进 sequence：确认是用户动作，不占用外部事件序号，避免后续事件被误判为乱序。
      return journal(
        {
          ...next,
          simulation: {
            ...next.simulation,
            tasks: next.simulation.tasks.map((item) =>
              item.id === action.taskId
                ? { ...item, status: 'running' as const, updatedAt: now }
                : item,
            ),
          },
        },
        `${task.title} → 已确认继续`,
      );
    }
    case 'sim.reset':
      return { ...next, simulation: initialState(now).simulation };
    case 'clock.tick':
      return next;
  }
}

/** 屏幕情绪的有限集合。表情、提示语、动画都从这里分叉，不在渲染层临时编。 */
export type DisplayMood = 'idle' | 'focus' | 'busy' | 'waiting' | 'happy' | 'sad' | 'sleep';

export interface DisplayState {
  mood: DisplayMood;
  title: string;
  detail: string;
  simulated: boolean;
}

export interface DisplayOptions {
  /** 用户自定义的闲时标语；空或未给时用内置那句。 */
  idleLines?: readonly string[];
}

/** 标语轮换周期。二十秒够慢，不会像跑马灯；也够快，用户能发现自己写的话真的在换。 */
const idleRotationMs = 20_000;

/**
 * 屏幕上那两行小字：标题是「它对你说的话」，副标题是「它现在知道什么」。
 *
 * 之前这两行在空闲时都是废话（「今天也一起吧」+「自由时光」），
 * 待办、会话名这种真信息反而只躺在面板里。现在副标题先给待办数，
 * 再给用户自己起的会话名，最后才是那句安慰话。
 */
function idleDetail(state: AppState): string {
  if (state.session.title !== sessionLabels.idle) return state.session.title;
  const open = state.todos.filter((todo) => !todo.done).length;
  if (open > 0) return `还剩 ${open} 件小事`;
  if (state.todos.length > 0) return '都做完了，歇会儿';
  return '不用着急';
}

export function displayState(state: AppState, options: DisplayOptions = {}): DisplayState {
  if (!state.simulation.connected) {
    return {
      mood: 'sleep',
      title: '模拟连接已断开',
      detail: '工作状态待确认 · 本地计时仍有效',
      simulated: true,
    };
  }
  const tasks = state.simulation.tasks;
  const waiting = tasks.find((task) => task.status === 'waiting');
  const failed = tasks.find(
    (task) => task.status === 'failed' && state.now - task.updatedAt < 8_000,
  );
  if (waiting || failed) {
    return {
      mood: waiting ? 'waiting' : 'sad',
      title: waiting ? '等你确认一下' : '有一处需要检查',
      detail: (waiting ?? failed)!.title,
      simulated: true,
    };
  }
  if (state.timer?.status === 'completed') {
    return {
      mood: 'happy',
      title: '这一段，完成啦',
      detail: '计时结束不代表任务完成',
      simulated: false,
    };
  }
  if (state.timer?.status === 'recovery') {
    return {
      mood: 'waiting',
      title: '计时等待恢复',
      detail: '在控制面板选择继续或结束',
      simulated: false,
    };
  }
  const success = tasks.find(
    (task) => task.status === 'succeeded' && state.now - task.updatedAt < 8_000,
  );
  if (success)
    return { mood: 'happy', title: '任务顺利完成', detail: success.title, simulated: true };
  const running = tasks.find((task) => task.status === 'running');
  if (running) {
    return {
      mood: 'busy',
      title: '正在进行中',
      detail: running.progress
        ? `${running.title} · ${running.progress.completed}/${running.progress.total}`
        : running.title,
      simulated: true,
    };
  }
  if (state.petUntil > state.now)
    return {
      mood: 'happy',
      title: '收到你的摸摸啦',
      detail: '本地互动 · 不使用 AI',
      simulated: false,
    };
  if (state.timer?.status === 'running' || state.timer?.status === 'paused') {
    return {
      mood: 'focus',
      title: state.timer.status === 'paused' ? '稍停一下也没关系' : '我陪你，慢慢来',
      detail: state.session.title,
      simulated: false,
    };
  }
  if (state.session.kind === 'entertainment')
    return {
      mood: 'happy',
      title: '现在，休息一下',
      detail: '按互动按钮，或玩个小游戏',
      simulated: false,
    };
  const lines =
    options.idleLines !== undefined && options.idleLines.length > 0
      ? options.idleLines
      : builtInIdleLines;
  // 按时间轮换，而不是随机：同一个时刻两个窗口显示同一句，截图和测试才可复现。
  const phrase = lines[Math.floor(state.now / idleRotationMs) % lines.length] ?? lines[0]!;
  return { mood: 'idle', title: phrase, detail: idleDetail(state), simulated: false };
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.ceil(Math.max(0, milliseconds) / 1_000);
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

/** 小屏右上角的时间。用本机时区，跟系统时钟一致；不显示秒，免得每秒都刷新。 */
export function formatClock(now: number): string {
  const date = new Date(now);
  return `${date.getHours().toString().padStart(2, '0')}:${date
    .getMinutes()
    .toString()
    .padStart(2, '0')}`;
}
