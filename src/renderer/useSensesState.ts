import { useEffect, useState } from 'react';
import { emptySenses, type SensesSnapshot } from '../core/senses';

/**
 * 主进程持有的那台「感官」：开关 + 最近读数。
 *
 * 桌宠用它判断采不采、面板用它显示状态。两边订阅同一份，
 * 所以面板里关掉麦克风，桌宠的指示灯和表情会立刻跟着停。
 */
export function useSensesSnapshot(): SensesSnapshot {
  const [snapshot, setSnapshot] = useState<SensesSnapshot>(() => emptySenses());
  useEffect(() => {
    let live = true;
    void window.companion!.sensesState().then((value) => {
      if (live) setSnapshot(value);
    });
    const off = window.companion!.onSensesState(setSnapshot);
    return () => {
      live = false;
      off();
    };
  }, []);
  return snapshot;
}
