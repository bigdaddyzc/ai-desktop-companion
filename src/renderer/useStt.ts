import { useEffect, useState } from 'react';
import { emptySttSnapshot, type SttSnapshot } from '../core/stt';

/**
 * 语音转写的状态：开关、有没有 Key、上一次转出的字。
 *
 * 面板拿它显示配置和「真的通了」的证据，桌宠拿它决定麦克风按钮亮不亮。
 * 两边订阅同一份，所以面板里填完 Key，小屏上的按钮立刻就活了。
 */
export function useSttSnapshot(): SttSnapshot {
  const [snapshot, setSnapshot] = useState<SttSnapshot>(() => emptySttSnapshot());
  useEffect(() => {
    let live = true;
    void window.companion!.sttState().then((value) => {
      if (live) setSnapshot(value);
    });
    const off = window.companion!.onSttState(setSnapshot);
    return () => {
      live = false;
      off();
    };
  }, []);
  return snapshot;
}
