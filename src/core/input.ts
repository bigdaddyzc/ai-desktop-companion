/**
 * F-03 输入语义：桌面按钮与未来实体按钮共用的手势判定与映射表。
 *
 * 这一层只描述「物理手势 → 逻辑动作」，不依赖 React、Electron 或真实时钟。
 * 时间与信号由调用方注入，测试不需要等待真实毫秒。
 * 实体 GPIO 的去抖电路、中断时序和长按手感尚未在硬件上验证。
 */

export const inputSpec = {
  /** 交互规格版本；映射表导出时一并写入，便于桌面／固件对照。 */
  version: 2,
  /** 长按判定阈值。PRD 建议起点，当前仅为桌面原型取值。 */
  longPressMs: 800,
  /** 释放后忽略再次按下的窗口，用于抑制机械抖动造成的重复短按。 */
  debounceMs: 50,
  /** 长按期间不重复发动作；一次按下最多产生一个手势。 */
  repeat: 'disabled',
  /** 桌面原型只处理单键序列；两个按钮同时按下不承诺可识别。 */
  chords: 'unsupported',
} as const;

export type ButtonId = 'A' | 'B';
export type Gesture = 'short' | 'long';

export interface InputMapping {
  button: ButtonId;
  gesture: Gesture;
  /** 设备侧动作标识；未分配时为 'unassigned'。 */
  action: string;
  assigned: boolean;
  desktopEffect: string;
  hardwareNote: string;
}

/**
 * 唯一输入映射表。A 长按明确标为未分配，不伪造动作，也不允许补发短按。
 * BOOT / RESET 是板载真实用途，不在此表内，不冒充业务按钮。
 */
export const inputMappings: readonly InputMapping[] = [
  {
    button: 'A',
    gesture: 'short',
    action: 'confirm-or-interact',
    assigned: true,
    desktopEffect:
      '优先级：允许屏上的动作请求（跑命令/看屏幕/派活）→ 接住它的主动提醒（细说/好）→ 确认模拟任务 → 本地摸摸；反应游戏中作为确认键。',
    hardwareNote: '外接业务按钮 A 短按；不等同于板载 BOOT。',
  },
  {
    button: 'A',
    gesture: 'long',
    action: 'unassigned',
    assigned: false,
    desktopEffect: '预留手势：不产生业务动作，也不会在松开时补发短按。',
    hardwareNote: '实体端需在固件中定义；当前无分配。',
  },
  {
    button: 'B',
    gesture: 'short',
    action: 'game-toggle',
    assigned: true,
    desktopEffect:
      '优先级：拒绝屏上的动作请求 → 收起主动提醒（知道了）→ 开始或退出反应小游戏；有需处理的工作提示时不启动游戏。',
    hardwareNote: '外接业务按钮 B 短按；不等同于板载 RESET。',
  },
  {
    button: 'B',
    gesture: 'long',
    action: 'quiet-toggle',
    assigned: true,
    desktopEffect: '切换勿扰；不发送计时系统通知，屏幕状态仍会更新。',
    hardwareNote: 'PRD 规定的预定义行为；实体端需在固件中实现相同动作。',
  },
];

export function mappingFor(button: ButtonId, gesture: Gesture): InputMapping | undefined {
  return inputMappings.find((item) => item.button === button && item.gesture === gesture);
}

/** 生成可导出的映射表文本。内容是固定描述，不含任何个人数据或模拟事件。 */
export function inputMappingReport(): string {
  return JSON.stringify(
    {
      kind: 'xinban-input-mapping',
      spec: inputSpec,
      mappings: inputMappings,
      boundary: [
        '桌面原型手势语义，尚未在 ESP32-S3 实体 GPIO 上验证。',
        '屏幕与 A/B 按钮是外接扩展件；BOOT / RESET 不参与业务映射。',
        '触摸点击仅用于桌面详情，不代表实体触摸屏能力。',
        '仅处理单键序列，不支持两个按钮同时按下的和弦输入。',
        'A 长按未分配，不伪造已实现动作。',
        '实体按键只上报原始按下/抬起（见 docs/hardware-protocol.md），手势判定与动作由主机同一套规则给出。',
      ],
    },
    null,
    2,
  );
}

export interface ActivePress {
  button: ButtonId;
  startedAt: number;
  longFired: boolean;
}

export interface InputState {
  press: ActivePress | null;
  /** 每个按钮独立的去抖时间戳，避免 A→B 快速交替输入被误判为抖动。 */
  lastReleaseAt: Record<ButtonId, number | null>;
}

export type InputSignal =
  | { type: 'down'; button: ButtonId; at: number }
  | { type: 'up'; button: ButtonId; at: number }
  | { type: 'tick'; button: ButtonId; at: number }
  | { type: 'cancel'; at: number };

export type InputOutcome =
  | { kind: 'gesture'; button: ButtonId; gesture: Gesture }
  | { kind: 'ignored'; reason: 'bounce' | 'duplicate' | 'no-press' | 'mismatch' | 'settled' };

export interface InputStep {
  state: InputState;
  outcome: InputOutcome | null;
}

export function initialInputState(): InputState {
  return { press: null, lastReleaseAt: { A: null, B: null } };
}

/**
 * 处理一次输入信号。一次按下最多产生一个手势：
 * - 到阈值时 tick 立即产出 long，并标记 longFired；
 * - 之后的 up 不再产出 short，避免「长按又触发短按」；
 * - 若定时器延迟、up 已越过阈值，仍按 long 结算，不误判成短按。
 */
export function stepInput(state: InputState, signal: InputSignal): InputStep {
  switch (signal.type) {
    case 'down': {
      if (state.press) return { state, outcome: { kind: 'ignored', reason: 'duplicate' } };
      const last = state.lastReleaseAt[signal.button];
      if (last !== null && signal.at - last < inputSpec.debounceMs) {
        return { state, outcome: { kind: 'ignored', reason: 'bounce' } };
      }
      return {
        state: {
          press: { button: signal.button, startedAt: signal.at, longFired: false },
          lastReleaseAt: state.lastReleaseAt,
        },
        outcome: null,
      };
    }
    case 'tick': {
      const press = state.press;
      if (!press || press.button !== signal.button) {
        return {
          state,
          outcome: press ? { kind: 'ignored', reason: 'mismatch' } : null,
        };
      }
      if (press.longFired) return { state, outcome: { kind: 'ignored', reason: 'settled' } };
      if (signal.at - press.startedAt < inputSpec.longPressMs) return { state, outcome: null };
      return {
        state: { ...state, press: { ...press, longFired: true } },
        outcome: { kind: 'gesture', button: press.button, gesture: 'long' },
      };
    }
    case 'up': {
      const press = state.press;
      if (!press || press.button !== signal.button) {
        return { state, outcome: { kind: 'ignored', reason: 'no-press' } };
      }
      const released: InputState = {
        press: null,
        lastReleaseAt: { ...state.lastReleaseAt, [press.button]: signal.at },
      };
      if (press.longFired) {
        return { state: released, outcome: { kind: 'ignored', reason: 'settled' } };
      }
      const gesture: Gesture =
        signal.at - press.startedAt >= inputSpec.longPressMs ? 'long' : 'short';
      return {
        state: released,
        outcome: { kind: 'gesture', button: press.button, gesture },
      };
    }
    case 'cancel': {
      const button = state.press?.button;
      return {
        state: {
          press: null,
          lastReleaseAt: button
            ? { ...state.lastReleaseAt, [button]: signal.at }
            : state.lastReleaseAt,
        },
        outcome: null,
      };
    }
  }
}
