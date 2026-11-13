import { useEffect, useState } from 'react';
import { emptyAiSession, type AiSessionState } from '../core/ai-session';

/**
 * 订阅主进程持有的对话。
 * 桌宠窗口与控制面板都用这个 hook，因此两处看到同一段对话。
 */
export function useAiSession(): AiSessionState {
  const [session, setSession] = useState<AiSessionState>(() => emptyAiSession());
  useEffect(() => {
    let alive = true;
    // 先拉快照再订阅：反过来会丢掉两步之间到达的更新。
    void window.companion!.aiSession().then((value) => {
      if (alive) setSession(value);
    });
    const unsubscribe = window.companion!.onAiSession((value) => {
      if (alive) setSession(value);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  return session;
}
