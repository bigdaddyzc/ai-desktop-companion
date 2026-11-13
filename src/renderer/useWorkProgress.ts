import { useEffect, useState } from 'react';
import { emptyProgress, type WorkProgressState } from '../core/progress';

/**
 * 订阅主进程的工作进度。
 *
 * 主进程每 15 秒扫一次，这里只负责显示；挂载时主动 refresh 一次，
 * 免得刚打开面板要干等一个周期。桥不可用时安静地返回空状态——
 * 进度是锦上添花，不能因为它让界面报错。
 */
export function useWorkProgress(): WorkProgressState {
  const [state, setState] = useState<WorkProgressState>(() => emptyProgress());

  useEffect(() => {
    const bridge = window.companion;
    if (!bridge) return;
    let alive = true;
    const off = bridge.onWorkState((next) => {
      if (alive) setState(next);
    });
    void bridge
      .workRefresh()
      .then((next) => {
        if (alive) setState(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off();
    };
  }, []);

  return state;
}
