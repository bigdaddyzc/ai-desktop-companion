import { useEffect, useState } from 'react';
import { emptyConfirm, type ConfirmSnapshot } from '../core/confirm';
import { emptyDeviceSnapshot, type DeviceSnapshot } from '../core/device-protocol';
import { defaultProactive, type ProactiveSnapshot } from '../core/proactive';
import { emptyMusic, type MusicSnapshot } from '../core/music';

/**
 * 「先订阅、再拉快照」的通用写法。
 *
 * 顺序很重要：先拉快照再订阅时，中间那次广播会丢；先订阅再拉时，
 * 晚到的快照又可能盖掉更新的广播。这里先订阅，且只要收到过广播就丢弃快照。
 */
export function useLive<T>(
  initial: () => T,
  load: (() => Promise<T>) | undefined,
  subscribe: ((listener: (value: T) => void) => () => void) | undefined,
): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    if (!load || !subscribe) return;
    let live = true;
    let pushed = false;
    const off = subscribe((next) => {
      pushed = true;
      if (live) setValue(next);
    });
    void load()
      .then((next) => {
        if (live && !pushed) setValue(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      off();
    };
    // 桥对象在窗口生命周期内不变，只订阅一次。
  }, []);
  return value;
}

function bridge() {
  return window.companion;
}

export function useConfirm(): ConfirmSnapshot {
  const companion = bridge();
  return useLive(emptyConfirm, companion?.confirmState, companion?.onConfirmState);
}

export function emptyProactiveSnapshot(): ProactiveSnapshot {
  return {
    config: defaultProactive,
    current: null,
    queued: 0,
    history: [],
    petLine: null,
    bond: {
      dayNumber: 1,
      daysTogether: 0,
      streak: 0,
      longestStreak: 0,
      pets: 0,
      todosDone: 0,
      focusMinutes: 0,
      today: { todosDone: 0, focusMinutes: 0, delegated: 0, pets: 0 },
    },
  };
}

export function useProactive(): ProactiveSnapshot {
  const companion = bridge();
  return useLive(emptyProactiveSnapshot, companion?.proactiveState, companion?.onProactiveState);
}

export function useMusic(): MusicSnapshot {
  const companion = bridge();
  return useLive(() => emptyMusic(false), companion?.musicState, companion?.onMusicState);
}

export function useDevice(): DeviceSnapshot {
  const companion = bridge();
  return useLive(emptyDeviceSnapshot, companion?.deviceState, companion?.onDeviceState);
}
