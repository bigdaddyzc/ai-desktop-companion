import type { PendingConfirm } from './confirm';
import { needsFullScreen, secondsLeft } from './confirm';
import type { FaceSpec } from './expression';
import type { Nudge, NudgeMood } from './proactive';
import type { AppState } from './schema';
import {
  displayState,
  formatClock,
  formatDuration,
  remainingMs,
  type DisplayMood,
  type DisplayOptions,
} from './state';

/**
 * 小屏上「该显示什么」的唯一答案。
 *
 * 桌面桌宠和将来的实体屏（ESP32 + 小屏）消费同一份 DeviceView：
 * 桌面用 React 画，固件用 LVGL/TFT 画，但「画什么」只在这里决定。
 * 这样硬件接入不需要在固件里重写一遍业务判断，也不会出现两块屏说法不一。
 *
 * 字段都是短文本与枚举：串口带宽有限，屏幕很小，固件不该做排版之外的事。
 */

export type DeviceCard =
  | {
      kind: 'confirm';
      id: string;
      title: string;
      detail: string;
      seconds: number;
      queued: number;
      hintA: string;
      hintB: string;
    }
  | {
      kind: 'nudge';
      id: string;
      text: string;
      mood: NudgeMood;
      hintA: string;
      hintB: string;
    };

export interface DeviceView {
  v: 1;
  mood: DisplayMood;
  face: Pick<FaceSpec, 'eyes' | 'brows' | 'mouth' | 'extra' | 'blush'> | null;
  title: string;
  detail: string;
  /** 右上角：时间或「勿扰」。 */
  corner: string;
  quiet: boolean;
  card: DeviceCard | null;
  timer: { label: string; remaining: string } | null;
  todo: { title: string; more: number; due: string } | null;
  /** 正在干活的 agent 一行；空串表示没有。 */
  work: string;
  /** 最近一句 AI 回复或摸摸反应；空串表示不显示气泡。 */
  bubble: string;
}

export interface DeviceViewInput {
  state: AppState;
  displayOptions?: DisplayOptions;
  face?: FaceSpec | null;
  confirm: PendingConfirm | null;
  confirmQueued?: number;
  nudge: Nudge | null;
  work?: string;
  bubble?: string;
}

const nudgeMoodToDisplay: Record<NudgeMood, DisplayMood> = {
  happy: 'happy',
  waiting: 'waiting',
  sad: 'sad',
  idle: 'idle',
};

/** 待办到期的短写：今天只写时刻，其余写「M/D」，过期写「已到点」。 */
export function dueLabel(dueAt: number | null | undefined, now: number): string {
  if (typeof dueAt !== 'number') return '';
  if (dueAt <= now) return '已到点';
  const due = new Date(dueAt);
  const today = new Date(now);
  const time = formatClock(dueAt);
  if (
    due.getFullYear() === today.getFullYear() &&
    due.getMonth() === today.getMonth() &&
    due.getDate() === today.getDate()
  ) {
    return `今天 ${time}`;
  }
  return `${due.getMonth() + 1}/${due.getDate()} ${time}`;
}

export function buildDeviceView(input: DeviceViewInput): DeviceView {
  const { state } = input;
  const display = displayState(state, input.displayOptions);
  const now = state.now;
  let card: DeviceCard | null = null;
  let mood = display.mood;
  if (input.confirm !== null) {
    card = {
      kind: 'confirm',
      id: input.confirm.id,
      title: input.confirm.title,
      detail: input.confirm.detail,
      seconds: secondsLeft(input.confirm, now),
      queued: input.confirmQueued ?? 0,
      // 小屏放不下全文时 A 不算允许（见 ConfirmService.answerFromDevice），提示去桌面上看。
      hintA: needsFullScreen(input.confirm) ? '去桌面看全文' : '允许',
      hintB: '拒绝',
    };
    mood = 'waiting';
  } else if (input.nudge !== null) {
    card = {
      kind: 'nudge',
      id: input.nudge.id,
      text: input.nudge.text,
      mood: input.nudge.mood,
      hintA:
        input.nudge.kind === 'hooks-lost' ? '重装' : input.nudge.askPrompt !== '' ? '细说' : '好',
      hintB: '知道了',
    };
    mood = nudgeMoodToDisplay[input.nudge.mood];
  }
  const timer =
    state.timer && state.timer.status !== 'completed'
      ? {
          label:
            state.timer.status === 'paused'
              ? '已暂停'
              : state.timer.status === 'recovery'
                ? '待恢复'
                : '专注中',
          remaining: formatDuration(remainingMs(state.timer, now)),
        }
      : null;
  const open = state.todos.filter((todo) => !todo.done);
  // 屏上只放一件：有到期时间的排前面，越早到期越靠前；都没有就取最新的一件。
  const next = [...open].sort((a, b) => {
    const left = a.dueAt ?? Number.POSITIVE_INFINITY;
    const right = b.dueAt ?? Number.POSITIVE_INFINITY;
    return left - right;
  })[0];
  const face = input.face ?? null;
  return {
    v: 1,
    mood,
    face: face
      ? {
          eyes: face.eyes,
          brows: face.brows,
          mouth: face.mouth,
          extra: face.extra,
          blush: face.blush,
        }
      : null,
    title: display.title,
    detail: display.detail,
    corner: state.settings.quiet ? '勿扰' : formatClock(now),
    quiet: state.settings.quiet,
    card,
    timer,
    todo: next
      ? { title: next.title, more: open.length - 1, due: dueLabel(next.dueAt, now) }
      : null,
    work: input.work ?? '',
    bubble: input.bubble ?? '',
  };
}
