import { useEffect, useState } from 'react';
import { setupSteps, type SetupStep } from '../core/setup-check';

/**
 * 首启检查：还差哪几步。全部做完就不显示。
 * 只读已有状态；在别的卡片里弄完后点「再查一次」。
 */
export function SetupCard() {
  const [steps, setSteps] = useState<SetupStep[] | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let alive = true;
    const bridge = window.companion!;
    void Promise.all([
      bridge.hooksStatus().catch(() => null),
      bridge.delegateState().catch(() => null),
      bridge.aiStatus().catch(() => null),
    ]).then(([hooks, delegate, ai]) => {
      if (alive) setSteps(setupSteps({ hooks, delegate, ai }));
    });
    return () => {
      alive = false;
    };
  }, [round]);
  if (steps === null || steps.every((step) => step.done)) return null;
  const left = steps.filter((step) => !step.done).length;
  return (
    <section className="card" data-testid="setup-card">
      <div className="section-heading">
        <h2>开始之前</h2>
        <span className="label">还差 {left} 步</span>
      </div>
      <ul className="plain-list">
        {steps.map((step) => (
          <li key={step.key} data-testid={`setup-${step.key}`}>
            <span className={step.done ? 'outcome-allowed' : ''}>
              {step.done ? '✓' : '○'} {step.label}
            </span>
            {!step.done && <small className="muted"> — {step.hint}</small>}
          </li>
        ))}
      </ul>
      <div className="inline-actions">
        <button type="button" onClick={() => setRound((value) => value + 1)}>
          再查一次
        </button>
      </div>
    </section>
  );
}
