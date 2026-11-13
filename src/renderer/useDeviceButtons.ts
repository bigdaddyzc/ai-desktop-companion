import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import {
  initialInputState,
  inputSpec,
  stepInput,
  type ButtonId,
  type Gesture,
  type InputOutcome,
  type InputSignal,
} from '../core/input';

/**
 * 把桌面按钮事件交给 F-03 纯领域手势状态机。
 * 这里只注入时间，不重写判定规则；键盘 Enter / 空格走同一套语义。
 */
export function useDeviceButtons(onGesture: (button: ButtonId, gesture: Gesture) => void) {
  const state = useRef(initialInputState());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const callback = useRef(onGesture);
  callback.current = onGesture;
  const [pressing, setPressing] = useState<ButtonId | null>(null);

  const step = useCallback((signal: InputSignal): InputOutcome | null => {
    const result = stepInput(state.current, signal);
    state.current = result.state;
    if (result.outcome?.kind === 'gesture') {
      callback.current(result.outcome.button, result.outcome.gesture);
    }
    return result.outcome;
  }, []);

  const clearTimer = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const down = useCallback(
    (button: ButtonId) => {
      clearTimer();
      const at = performance.now();
      const outcome = step({ type: 'down', button, at });
      if (outcome !== null) return; // 抖动或重复按下被忽略，不安排长按判定。
      setPressing(button);
      timer.current = setTimeout(() => {
        step({ type: 'tick', button, at: performance.now() });
      }, inputSpec.longPressMs);
    },
    [clearTimer, step],
  );

  const up = useCallback(
    (button: ButtonId) => {
      clearTimer();
      step({ type: 'up', button, at: performance.now() });
      setPressing(null);
    },
    [clearTimer, step],
  );

  const cancel = useCallback(() => {
    clearTimer();
    step({ type: 'cancel', at: performance.now() });
    setPressing(null);
  }, [clearTimer, step]);

  useEffect(() => {
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('blur', cancel);
      clearTimer();
    };
  }, [cancel, clearTimer]);

  const bind = useCallback(
    (button: ButtonId) => ({
      onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0) return;
        // 指针捕获保证按下期间指针移出按钮仍能收到 up，不误触发短按。
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // 某些环境不支持捕获时仍按普通 pointer 事件处理。
        }
        down(button);
      },
      onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0) return;
        up(button);
      },
      onPointerCancel: cancel,
      onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
        if (event.repeat || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        down(button);
      },
      onKeyUp: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
        if (!['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        up(button);
      },
      onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>) => event.preventDefault(),
    }),
    [cancel, down, up],
  );

  return { bind, pressing };
}
