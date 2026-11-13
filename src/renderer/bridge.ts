import { useEffect, useRef, useState } from 'react';
import type { Action, CompanionBridge, Snapshot } from '../core/schema';

declare global {
  interface Window {
    companion?: CompanionBridge;
  }
}

export function useCompanion() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const revision = useRef(-1);
  useEffect(() => {
    const bridge = window.companion;
    if (!bridge) {
      setError('请通过 Electron 启动桌面应用，浏览器预览不具备本地状态服务。');
      return;
    }
    let active = true;
    const accept = (next: Snapshot) => {
      if (active && next.state.revision >= revision.current) {
        revision.current = next.state.revision;
        setSnapshot(next);
      }
    };
    const unsubscribe = bridge.subscribe(accept);
    void bridge
      .snapshot()
      .then(accept)
      .catch(() => setError('无法连接本地状态服务。'));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  async function send(action: Action): Promise<boolean> {
    setError('');
    try {
      const result = await window.companion!.dispatch(action);
      if (!result.ok) {
        setError(result.error);
        return false;
      }
      if (result.snapshot.state.revision >= revision.current) {
        revision.current = result.snapshot.state.revision;
        setSnapshot(result.snapshot);
      }
      return true;
    } catch {
      setError('操作未完成：无法连接本地状态服务。');
      return false;
    }
  }
  return { snapshot, error, setError, send };
}
