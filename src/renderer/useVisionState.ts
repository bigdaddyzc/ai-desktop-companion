import { useEffect, useState } from 'react';
import { emptyVisionSnapshot, type VisionSnapshot } from '../core/vision';

/**
 * 「它现在能不能看画面」的状态。
 *
 * 面板拿它画开关和「看一眼」的结果，桌宠目前只用来判断要不要提示。
 * 两边订阅同一份：面板里一打开，下一次对话它就知道自己有了眼睛。
 */
export function useVisionState(): VisionSnapshot {
  const [snapshot, setSnapshot] = useState<VisionSnapshot>(() => emptyVisionSnapshot());
  useEffect(() => {
    let live = true;
    void window.companion!.visionState().then((value) => {
      if (live) setSnapshot(value);
    });
    const off = window.companion!.onVisionState(setSnapshot);
    return () => {
      live = false;
      off();
    };
  }, []);
  return snapshot;
}
