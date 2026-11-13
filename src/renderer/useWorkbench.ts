import { useEffect, useState } from 'react';
import { emptyWorkbenchState, type WorkbenchState } from '../core/workbench';

/** 工作台：主进程算好、广播到两个窗口；桌宠只用摘要，面板用整张表。 */
export function useWorkbench(): WorkbenchState {
  const [state, setState] = useState<WorkbenchState>(() => emptyWorkbenchState());
  useEffect(() => {
    let live = true;
    void window.companion!.workbenchState().then((value) => {
      if (live && value !== null) setState(value);
    });
    const off = window.companion!.onWorkbench(setState);
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}
