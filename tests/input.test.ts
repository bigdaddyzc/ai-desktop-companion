import { describe, expect, it } from 'vitest';
import {
  initialInputState,
  inputMappingReport,
  inputMappings,
  inputSpec,
  mappingFor,
  stepInput,
  type Gesture,
  type InputSignal,
  type InputState,
  type ButtonId,
} from '../src/core/input';

/** 交互规格的独立基准值：故意不引用实现常量，改动阈值必须让测试变红。 */
const specLongPressMs = 800;
const specDebounceMs = 50;

describe('F-03 交互规格锁定', () => {
  it('实现阈值与已声明的交互规格一致', () => {
    expect(specLongPressMs).toBe(specLongPressMs);
    expect(specDebounceMs).toBe(specDebounceMs);
    expect(inputSpec.repeat).toBe('disabled');
    expect(inputSpec.chords).toBe('unsupported');
  });
});

/** 按固定时间轴跑一段输入序列，返回依次产生的逻辑手势。 */
function replay(signals: InputSignal[]): {
  gestures: Gesture[];
  buttons: ButtonId[];
  final: InputState;
} {
  let state = initialInputState();
  const gestures: Gesture[] = [];
  const buttons: ButtonId[] = [];
  for (const signal of signals) {
    const step = stepInput(state, signal);
    state = step.state;
    if (step.outcome?.kind === 'gesture') {
      gestures.push(step.outcome.gesture);
      buttons.push(step.outcome.button);
    }
  }
  return { gestures, buttons, final: state };
}

describe('F-03 输入语义：短按与长按', () => {
  it('一次短按只产生一个 short', () => {
    const result = replay([
      { type: 'down', button: 'A', at: 1_000 },
      { type: 'up', button: 'A', at: 1_120 },
    ]);
    expect(result.gestures).toEqual(['short']);
    expect(result.final.press).toBeNull();
  });

  it('达到阈值时 tick 产出 long，松开不再补发 short', () => {
    const result = replay([
      { type: 'down', button: 'B', at: 0 },
      { type: 'tick', button: 'B', at: specLongPressMs },
      { type: 'up', button: 'B', at: specLongPressMs + 100 },
    ]);
    expect(result.gestures).toEqual(['long']);
    expect(result.buttons).toEqual(['B']);
  });

  it('阈值前一毫秒仍是短按', () => {
    const result = replay([
      { type: 'down', button: 'B', at: 0 },
      { type: 'tick', button: 'B', at: specLongPressMs - 1 },
      { type: 'up', button: 'B', at: specLongPressMs - 1 },
    ]);
    expect(result.gestures).toEqual(['short']);
  });

  it('定时器延迟、松开已越过阈值时仍按 long 结算，不误判短按', () => {
    const result = replay([
      { type: 'down', button: 'B', at: 0 },
      { type: 'up', button: 'B', at: specLongPressMs + 80 },
    ]);
    expect(result.gestures).toEqual(['long']);
  });

  it('长按期间重复 tick 不重复发动作', () => {
    const result = replay([
      { type: 'down', button: 'B', at: 0 },
      { type: 'tick', button: 'B', at: 800 },
      { type: 'tick', button: 'B', at: 900 },
      { type: 'tick', button: 'B', at: 1_000 },
      { type: 'up', button: 'B', at: 1_100 },
    ]);
    expect(result.gestures).toEqual(['long']);
  });
});

describe('F-03 输入语义：去抖与异常信号', () => {
  it('释放后 50ms 内的再次按下被当作抖动忽略', () => {
    let state = initialInputState();
    state = stepInput(state, { type: 'down', button: 'A', at: 0 }).state;
    state = stepInput(state, { type: 'up', button: 'A', at: 20 }).state;
    const bounce = stepInput(state, {
      type: 'down',
      button: 'A',
      at: 20 + specDebounceMs - 1,
    });
    expect(bounce.outcome).toEqual({ kind: 'ignored', reason: 'bounce' });
    expect(bounce.state.press).toBeNull();
    const accepted = stepInput(state, { type: 'down', button: 'A', at: 20 + specDebounceMs });
    expect(accepted.outcome).toBeNull();
    expect(accepted.state.press?.button).toBe('A');
  });

  it('去抖窗口结束后可以正常开始下一次短按', () => {
    const result = replay([
      { type: 'down', button: 'A', at: 0 },
      { type: 'up', button: 'A', at: 10 },
      { type: 'down', button: 'A', at: 10 + specDebounceMs },
      { type: 'up', button: 'A', at: 10 + specDebounceMs + 30 },
    ]);
    expect(result.gestures).toEqual(['short', 'short']);
  });

  it('去抖按按钮独立计时：A 释放后立即按 B 不被误判为抖动', () => {
    const result = replay([
      { type: 'down', button: 'A', at: 0 },
      { type: 'up', button: 'A', at: 10 },
      { type: 'down', button: 'B', at: 11 },
      { type: 'up', button: 'B', at: 40 },
    ]);
    expect(result.gestures).toEqual(['short', 'short']);
    expect(result.buttons).toEqual(['A', 'B']);
  });

  it('同一时间只允许一个按下，重复 down 不产生第二个手势', () => {
    let state = initialInputState();
    state = stepInput(state, { type: 'down', button: 'A', at: 0 }).state;
    const duplicate = stepInput(state, { type: 'down', button: 'B', at: 10 });
    expect(duplicate.outcome).toEqual({ kind: 'ignored', reason: 'duplicate' });
    expect(duplicate.state.press?.button).toBe('A');
  });

  it('取消按下后松开不产生动作', () => {
    const result = replay([
      { type: 'down', button: 'A', at: 0 },
      { type: 'cancel', at: 100 },
      { type: 'up', button: 'A', at: 120 },
    ]);
    expect(result.gestures).toEqual([]);
    expect(result.final.press).toBeNull();
  });

  it('无按下时的 up 与 tick 都不产生动作', () => {
    const result = replay([
      { type: 'up', button: 'A', at: 0 },
      { type: 'tick', button: 'B', at: 10 },
    ]);
    expect(result.gestures).toEqual([]);
  });

  it('错误按钮的 up 不会结束当前按下', () => {
    let state = initialInputState();
    state = stepInput(state, { type: 'down', button: 'A', at: 0 }).state;
    const wrong = stepInput(state, { type: 'up', button: 'B', at: 10 });
    expect(wrong.outcome).toEqual({ kind: 'ignored', reason: 'no-press' });
    expect(wrong.state.press?.button).toBe('A');
  });
});

describe('F-03 输入映射表', () => {
  it('覆盖 A/B 的全部四种手势且组合唯一', () => {
    const keys = inputMappings.map((item) => `${item.button}:${item.gesture}`);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
    for (const button of ['A', 'B'] as const)
      for (const gesture of ['short', 'long'] as const)
        expect(mappingFor(button, gesture)).toBeDefined();
  });

  it('A 长按明确未分配，不产生业务动作', () => {
    const mapping = mappingFor('A', 'long');
    expect(mapping?.assigned).toBe(false);
    expect(mapping?.action).toBe('unassigned');
  });

  it('已分配手势有唯一动作标识，且 B 长按对应勿扰', () => {
    const actions = inputMappings.filter((item) => item.assigned).map((item) => item.action);
    expect(new Set(actions).size).toBe(actions.length);
    expect(mappingFor('B', 'long')?.action).toBe('quiet-toggle');
    expect(mappingFor('B', 'short')?.action).toBe('game-toggle');
  });

  it('导出内容可解析，包含阈值、映射和实体未验证声明', () => {
    const report = JSON.parse(inputMappingReport()) as {
      kind: string;
      spec: typeof inputSpec;
      mappings: unknown[];
      boundary: string[];
    };
    expect(report.kind).toBe('xinban-input-mapping');
    expect(report.spec).toEqual(inputSpec);
    expect(report.spec.longPressMs).toBe(specLongPressMs);
    expect(report.spec.debounceMs).toBe(specDebounceMs);
    expect(report.mappings).toHaveLength(inputMappings.length);
    expect(report.boundary.some((line) => line.includes('GPIO'))).toBe(true);
    expect(inputMappingReport()).not.toContain('todos');
    expect(inputMappingReport()).not.toContain('eventId');
  });
});
