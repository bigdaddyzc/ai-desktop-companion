import { useEffect, useState } from 'react';
import type { ReviewResult } from '../core/review';
import { formatClock } from '../core/state';
import { workbenchKindLabels, type WorkbenchItem, type WorkbenchState } from '../core/workbench';
import { followUpRequest } from './WorkbenchCard';

/**
 * 桌宠小屏上的工作台：点「N 个待看」就在屏上看结论、改了几个文件、标已看、开编辑器。
 * 完整 diff 和长结论屏上放不下，留一个「面板 ↗」。
 */
export function PetBench({
  bench,
  onClose,
  onNote,
  onOpenPanel,
  onFollowUp,
}: {
  bench: WorkbenchState;
  onClose: () => void;
  onNote: (text: string) => void;
  onOpenPanel?: () => void;
  /** 「接着派」：切到对话，输入框里填好开头。 */
  onFollowUp: (prefix: string) => void;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const open = bench.items.find((item) => item.key === openKey) ?? null;
  const items = bench.items.filter((item) => item.kind !== 'idle');

  function pick(item: WorkbenchItem) {
    if (item.kind === 'waiting') {
      onNote(
        item.terminalOnly
          ? `${item.agent} 没有能回传决定的钩子，回终端点`
          : '确认卡不在了：可能已交回终端',
      );
      return;
    }
    setOpenKey(item.key);
  }

  return (
    <div className="pet-bench" data-testid="pet-bench">
      {open ? (
        <PetResult
          item={open}
          onBack={() => setOpenKey(null)}
          onNote={onNote}
          onOpenPanel={onOpenPanel}
          onFollowUp={onFollowUp}
        />
      ) : items.length === 0 ? (
        <p className="pet-bench-empty">现在没有要你管的活。</p>
      ) : (
        <ul className="pet-bench-list">
          {items.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                className={`pet-bench-row bench-${item.kind}`}
                data-testid="pet-bench-item"
                onClick={() => pick(item)}
              >
                <span className={`bench-kind bench-kind-${item.kind}`}>
                  {workbenchKindLabels[item.kind]}
                </span>
                <span className="pet-bench-title">{item.title}</span>
                <small>
                  {formatClock(item.at)}
                  {item.detail ? ` · ${item.detail}` : ''}
                </small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!open && (
        <div className="pet-bench-actions">
          <button type="button" onClick={onClose}>
            ← 收起
          </button>
          {onOpenPanel && (
            <button type="button" onClick={onOpenPanel}>
              面板 ↗
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PetResult({
  item,
  onBack,
  onNote,
  onOpenPanel,
  onFollowUp,
}: {
  item: WorkbenchItem;
  onBack: () => void;
  onNote: (text: string) => void;
  onOpenPanel?: () => void;
  onFollowUp: (prefix: string) => void;
}) {
  const [review, setReview] = useState<ReviewResult | null | undefined>(undefined);
  // 点开就读一次工作区改动（只读 git）：屏上只放「N 个文件 +x/-y」。
  useEffect(() => {
    if (item.cwd === '') return;
    let alive = true;
    window
      .companion!.workbenchReview(item.key)
      .then((next) => {
        if (alive) setReview(next);
      })
      .catch(() => {
        if (alive) setReview(null);
      });
    return () => {
      alive = false;
    };
  }, [item.key, item.cwd]);

  async function seen() {
    const result = await window.companion!.workbenchSeen(item.key).catch(() => null);
    if (result?.ok) {
      onNote('已看（不等于验收通过）');
      onBack();
    } else onNote(result?.error ?? '没标上，请重试');
  }
  async function openEditor() {
    const result = await window.companion!.workbenchOpen(item.key).catch(() => null);
    onNote(result?.ok ? '在编辑器里打开了' : (result?.error ?? '没打开'));
  }

  const changes =
    review === undefined
      ? item.cwd === ''
        ? ''
        : '在读改动…'
      : review === null
        ? '看不到改动'
        : review.status === 'git' && review.files.length > 0
          ? `工作区 ${review.files.length} 个文件 · +${review.added} / -${review.deleted}`
          : review.note;
  const tests =
    item.origin !== 'delegate'
      ? ''
      : item.tests.length > 0
        ? `它报的测试：${item.tests.slice(0, 2).join('；')}`
        : '未取得测试证据';

  return (
    <div className="pet-result" data-testid="pet-result">
      <strong className="pet-bench-title">
        <span className={`bench-kind bench-kind-${item.kind}`}>
          {workbenchKindLabels[item.kind]}
        </span>{' '}
        {item.title}
      </strong>
      <div className="pet-result-body">
        {item.task && <p className="pet-result-muted">派的活：{item.task}</p>}
        <p>{item.result || item.detail || '它没留下结论。'}</p>
        {changes && <p className="pet-result-muted">{changes}</p>}
        {tests && <p className="pet-result-muted">{tests}</p>}
      </div>
      <div className="pet-bench-actions">
        <button type="button" aria-label="返回列表" onClick={onBack}>
          ←
        </button>
        {(item.kind === 'unseen' || item.kind === 'error') && (
          <button
            type="button"
            className="primary"
            data-testid="pet-bench-seen"
            title="只表示你看过了，不等于代码正确、验收通过"
            onClick={() => void seen()}
          >
            已看
          </button>
        )}
        {item.cwd !== '' && (
          <button type="button" onClick={() => void openEditor()} title="在编辑器里打开这个项目">
            编辑器
          </button>
        )}
        <button
          type="button"
          title="再派一项给同一个 Agent（新任务，仍要你点头）"
          onClick={() => onFollowUp(followUpRequest(item, ''))}
        >
          接着派
        </button>
        {onOpenPanel && (
          <button type="button" title="完整 diff 和长结论在面板里看" onClick={onOpenPanel}>
            ↗
          </button>
        )}
      </div>
    </div>
  );
}
