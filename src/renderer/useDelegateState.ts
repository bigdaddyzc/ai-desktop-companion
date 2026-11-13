import { useEffect, useState } from 'react';
import { emptyDelegateSnapshot, type DelegateSnapshot } from '../core/delegate';

/**
 * 「它能不能派活」的状态。
 *
 * 面板拿它画开关、显示命令装没装；桌宠不需要——派活是模型按授权自己决定的，
 * 小屏上只显示轨迹（「交给 Claude：…」），不放开关。
 */
export function useDelegateState(): DelegateSnapshot {
  const [snapshot, setSnapshot] = useState<DelegateSnapshot>(() => emptyDelegateSnapshot());
  useEffect(() => {
    let live = true;
    void window.companion!.delegateState().then((value) => {
      if (live) setSnapshot(value);
    });
    const off = window.companion!.onDelegateState(setSnapshot);
    return () => {
      live = false;
      off();
    };
  }, []);
  return snapshot;
}
