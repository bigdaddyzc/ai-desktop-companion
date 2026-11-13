import { useEffect, useState } from 'react';
import { memoryCategoryLabels } from '../core/memory';
import {
  tidyAfterCount,
  tidyKindLabels,
  type MemoryTidyState,
  type TidyAction,
} from '../core/memory-tidy';

const initial: MemoryTidyState = {
  phase: 'idle',
  plan: null,
  error: '',
  notice: '',
  suggest: false,
  canUndo: false,
};

/**
 * 记忆整理：放在「它记得你」卡片里。
 * 方案默认全勾，但必须点「应用」才生效；每一项都能单独取消。
 */
export function MemoryTidy({ factCount, enabled }: { factCount: number; enabled: boolean }) {
  const [tidy, setTidy] = useState<MemoryTidyState>(initial);
  const [selection, setSelection] = useState<{ at: number; ids: Set<string> } | null>(null);
  const [failure, setFailure] = useState('');

  useEffect(() => {
    void window.companion!.memoryTidyState().then(setTidy);
    return window.companion!.onMemoryTidyState(setTidy);
  }, []);

  // 新方案到了就默认全选：用户来整理就是想改，逐条勾太累；不同意的取消即可。
  const planAt = tidy.plan?.createdAt ?? 0;
  const picked =
    selection !== null && selection.at === planAt
      ? selection.ids
      : new Set(tidy.plan?.actions.map((action) => action.id) ?? []);

  async function run(call: () => Promise<MemoryTidyState>) {
    setFailure('');
    try {
      setTidy(await call());
    } catch {
      setFailure('操作没完成。');
    }
  }

  function toggle(id: string) {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelection({ at: planAt, ids: next });
  }

  if (!enabled) return null;
  const plan = tidy.plan;
  const thinking = tidy.phase === 'thinking';

  return (
    <div className="memory-tidy" data-testid="memory-tidy">
      {tidy.phase !== 'ready' && (
        <>
          {tidy.suggest && !thinking && (
            <p className="memory-tidy-hint">
              记忆攒了 {factCount} 条，里面多半有换个说法重复记的，可以整理一下。
            </p>
          )}
          <div className="button-row">
            <button
              type="button"
              className={tidy.suggest ? 'primary' : undefined}
              disabled={thinking || factCount === 0}
              onClick={() => void run(() => window.companion!.memoryTidyStart())}
            >
              {thinking ? '正在通读全部记忆…' : '整理记忆'}
            </button>
            {tidy.canUndo && !thinking && (
              <button
                type="button"
                onClick={() => void run(() => window.companion!.memoryTidyUndo())}
              >
                撤销上次整理
              </button>
            )}
          </div>
          {thinking && (
            <p className="muted">
              全部 {factCount} 条会发给 DeepSeek 看一遍，大约一两分钟。它只出方案，不会自己改。
            </p>
          )}
        </>
      )}

      {plan && tidy.phase === 'ready' && (
        <div className="memory-tidy-plan" data-testid="memory-tidy-plan">
          <h3>
            整理方案：{plan.before} 条 → {tidyAfterCount(plan, [...picked])} 条
          </h3>
          <p className="muted">去掉勾的那项不改。应用前会自动备份，改完不满意可以撤销。</p>
          <ul>
            {plan.actions.map((action) => (
              <TidyItem
                key={action.id}
                action={action}
                checked={picked.has(action.id)}
                onToggle={() => toggle(action.id)}
              />
            ))}
          </ul>
          <div className="button-row">
            <button
              type="button"
              className="primary"
              disabled={picked.size === 0}
              onClick={() => void run(() => window.companion!.memoryTidyApply([...picked]))}
            >
              应用勾选的 {picked.size} 项
            </button>
            <button
              type="button"
              onClick={() => void run(() => window.companion!.memoryTidyDiscard())}
            >
              不整理了
            </button>
          </div>
        </div>
      )}

      {tidy.notice !== '' && <p className="memory-tidy-notice">{tidy.notice}</p>}
      {(failure || (tidy.phase === 'failed' && tidy.error)) && (
        <p className="error-text">{failure || tidy.error}</p>
      )}
    </div>
  );
}

function TidyItem({
  action,
  checked,
  onToggle,
}: {
  action: TidyAction;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <li className={`tidy-item tidy-${action.kind}`} data-testid="memory-tidy-item">
      <label>
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <span className={`tidy-kind tidy-kind-${action.kind}`}>{tidyKindLabels[action.kind]}</span>
        <span className="tidy-reason">{action.reason}</span>
      </label>
      <ul className="tidy-sources">
        {action.sources.map((source) => (
          <li key={source.id}>{source.text}</li>
        ))}
      </ul>
      {action.kind !== 'drop' && (
        <p className="tidy-result">
          → <span className="memory-tag">{memoryCategoryLabels[action.category]}</span>{' '}
          {action.text}
        </p>
      )}
    </li>
  );
}
