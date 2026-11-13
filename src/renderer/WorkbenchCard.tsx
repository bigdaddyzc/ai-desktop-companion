import { useEffect, useState } from 'react';
import { baselineNotes, type ReviewResult } from '../core/review';
import { formatClock } from '../core/state';
import { workbenchKindLabels, type WorkbenchItem } from '../core/workbench';
import { useWorkbench } from './useWorkbench';

/**
 * 「再派一项」：交给伙伴转派，走现有的派活（仍要你点头）。
 * 这是一件新任务，不是接上原会话：没有哪个工具提供了可靠的续接契约。
 */
export function followUpRequest(
  item: Pick<WorkbenchItem, 'agent' | 'project'>,
  text: string,
): string {
  const where = item.project ? `在 ${item.project} 项目里` : '';
  return `${where}再派一项给 ${item.agent}（新任务，不接原会话）：${text.trim()}`;
}

/**
 * 工作台：谁在等我。等你 → 出错 → 结果待看 → 在干 → 空闲。
 * 点开结束/出错的一行是结果卡：结论、工作区改动（只读 git）、Agent 报告的测试。
 */
export function WorkbenchCard() {
  const bench = useWorkbench();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [editor, setEditor] = useState<string | null>(null);
  // 没装任何钩子时没有事件可看：那是「尚未接入」，不是「没人等你」。
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void window
      .companion!.hooksStatus()
      .then((status) => {
        if (!alive) return;
        const targets = [status.claudeCode, status.codex, status.workbuddy, status.codebuddy];
        setConnected(targets.some((target) => target.status === 'installed'));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const open = bench.items.find((item) => item.key === openKey);

  function pick(item: WorkbenchItem) {
    setNote('');
    if (item.kind === 'waiting') {
      if (item.terminalOnly) {
        setNote(`${item.agent} 没有能回传决定的钩子，回终端点。`);
      } else {
        const banner = document.querySelector('[data-testid="confirm-banner"]');
        if (banner) banner.scrollIntoView({ behavior: 'smooth', block: 'center' });
        else setNote('确认卡已经不在了：可能已交回终端，去终端看一眼。');
      }
      return;
    }
    setOpenKey(openKey === item.key ? null : item.key);
  }

  async function saveEditor(value: string) {
    const result = await window.companion!.workbenchEditor(value).catch(() => null);
    if (result?.ok) {
      setEditor(null);
      setNote('');
    } else setNote(result?.error ?? '没保存上，请重试。');
  }

  return (
    <section className="card" data-testid="workbench-card">
      <div className="section-heading">
        <h2>工作台</h2>
        <span className="label" data-testid="workbench-summary">
          {bench.summary || (connected === false ? '尚未接入' : '没人等你')}
        </span>
      </div>
      {bench.items.length === 0 ? (
        <div className="empty-state" data-testid="workbench-empty">
          {connected === false
            ? '尚未接入：还没给任何 Agent 装钩子，芯伴看不到它们在干什么。在下面「官方通知钩子」里装好后，会话和派出去的活都会列在这里。'
            : '现在没有 Agent 在干活。Claude Code / Codex / WorkBuddy 的会话和芯伴派出去的活都会列在这里。'}
        </div>
      ) : (
        <ul className="plain-list workbench-list">
          {bench.items.map((item) => (
            <li key={item.key} className={`workbench-row bench-${item.kind}`}>
              <button
                type="button"
                className="workbench-pick"
                data-testid="workbench-item"
                aria-expanded={item.key === openKey}
                onClick={() => pick(item)}
              >
                <span className={`bench-kind bench-kind-${item.kind}`}>
                  {workbenchKindLabels[item.kind]}
                </span>
                <b>{item.title}</b>
                <small>
                  {formatClock(item.at)}
                  {item.detail ? ` · ${item.detail}` : ''}
                </small>
              </button>
              {item.key === openKey && open && (
                <ResultCard key={item.key} item={open} onNote={setNote} />
              )}
            </li>
          ))}
        </ul>
      )}
      {note && (
        <p className="muted" role="status">
          {note}
        </p>
      )}
      <div className="toggle-row">
        <span>在编辑器打开用</span>
        {editor === null ? (
          <>
            <code data-testid="workbench-editor">{bench.config.editor}</code>
            <button type="button" onClick={() => setEditor(bench.config.editor)}>
              换
            </button>
          </>
        ) : (
          <form
            className="inline-actions"
            onSubmit={(event) => {
              event.preventDefault();
              void saveEditor(editor);
            }}
          >
            <input
              aria-label="编辑器命令"
              value={editor}
              maxLength={260}
              placeholder="code / cursor / 程序完整路径"
              onChange={(event) => setEditor(event.target.value)}
            />
            <button type="submit">保存</button>
            <button type="button" onClick={() => setEditor(null)}>
              取消
            </button>
          </form>
        )}
      </div>
    </section>
  );
}

function ResultCard({ item, onNote }: { item: WorkbenchItem; onNote: (note: string) => void }) {
  const [review, setReview] = useState<ReviewResult | null | undefined>(undefined);
  const [diff, setDiff] = useState<{ text: string; truncated: boolean } | null>(null);
  const [follow, setFollow] = useState('');
  const [busy, setBusy] = useState(false);
  const canReview = item.cwd !== '';

  async function loadReview() {
    setBusy(true);
    try {
      setReview(await window.companion!.workbenchReview(item.key));
    } catch {
      setReview(null);
    } finally {
      setBusy(false);
    }
  }
  async function loadDiff() {
    if (diff !== null) {
      setDiff(null);
      return;
    }
    const result = await window.companion!.workbenchDiff(item.key).catch(() => null);
    if (result?.ok) setDiff({ text: result.text || '（没有改动）', truncated: result.truncated });
    else onNote(result?.error ?? '取不到 diff。');
  }
  async function openEditor() {
    const result = await window.companion!.workbenchOpen(item.key).catch(() => null);
    onNote(result?.ok ? '' : (result?.error ?? '没打开。'));
  }
  async function seen() {
    const result = await window.companion!.workbenchSeen(item.key).catch(() => null);
    onNote(result?.ok ? '' : (result?.error ?? '没标上，请重试。'));
  }
  async function followUp() {
    if (follow.trim() === '') return;
    setBusy(true);
    try {
      const result = await window.companion!.aiSend(followUpRequest(item, follow));
      if (result.ok) {
        setFollow('');
        onNote('交给伙伴了：这是一件新任务，它会先问你再派出去。');
      } else onNote(result.error);
    } catch {
      onNote('没发出去。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workbench-result" data-testid="workbench-result">
      {item.task && (
        <p className="muted">
          派的活：<span>{item.task}</span>
        </p>
      )}
      {item.result ? (
        <pre className="workbench-conclusion">{item.result}</pre>
      ) : (
        <p className="muted">它没留下结论。</p>
      )}
      {item.origin === 'delegate' &&
        (item.tests.length > 0 ? (
          <>
            <p className="muted">Agent 报告的测试结果（芯伴没有自己跑、也没有核实）：</p>
            <ul className="plain-list small" data-testid="workbench-tests">
              {item.tests.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        ) : (
          <p className="muted" data-testid="workbench-no-tests">
            未取得测试证据：它的输出里没有认得出的测试摘要。
          </p>
        ))}
      {canReview && review === undefined && (
        <button type="button" disabled={busy} onClick={() => void loadReview()}>
          看工作区改动
        </button>
      )}
      {review === null && <p className="muted">看不到改动。</p>}
      {review?.status === 'git' &&
        (item.origin === 'delegate'
          ? baselineNotes(item.baseline, review.head)
          : ['下面是当前工作区的全部改动，可能包含你或其他任务的修改。']
        ).map((text) => (
          <p key={text} className="muted" data-testid="workbench-baseline">
            {text}
          </p>
        ))}
      {review && <ReviewView review={review} />}
      {diff && (
        <pre className="workbench-diff" data-testid="workbench-diff">
          {diff.text}
          {diff.truncated ? '\n……（太长了，只显示前面一部分）' : ''}
        </pre>
      )}
      <div className="inline-actions">
        {canReview && (
          <button type="button" onClick={() => void openEditor()} data-testid="workbench-open">
            在编辑器打开
          </button>
        )}
        {review?.status === 'git' && (
          <button type="button" onClick={() => void loadDiff()}>
            {diff ? '收起 diff' : '看完整 diff'}
          </button>
        )}
        {(item.kind === 'unseen' || item.kind === 'error') && (
          <button
            type="button"
            className="primary"
            onClick={() => void seen()}
            data-testid="workbench-seen"
            title="只表示你看过了，不等于代码正确、验收通过"
          >
            标记已看
          </button>
        )}
      </div>
      <form
        className="inline-actions"
        onSubmit={(event) => {
          event.preventDefault();
          void followUp();
        }}
      >
        <input
          aria-label="再派一项"
          value={follow}
          maxLength={500}
          placeholder={`再派一项给 ${item.agent}（新任务，不接原会话）…`}
          onChange={(event) => setFollow(event.target.value)}
        />
        <button type="submit" disabled={busy || follow.trim() === ''}>
          再派一项
        </button>
      </form>
    </div>
  );
}

const statusText: Record<string, string> = {
  '??': '新',
  ' M': '改',
  'M ': '改',
  MM: '改',
  'A ': '新',
  ' D': '删',
  'D ': '删',
};

function ReviewView({ review }: { review: ReviewResult }) {
  if (review.status !== 'git' || review.files.length === 0) {
    return <p className="muted">{review.note}</p>;
  }
  return (
    <>
      <p className="muted" data-testid="workbench-stat">
        {review.files.length} 个文件 · +{review.added} / -{review.deleted}
        {review.truncated ? ' · 太多了，只列了前面的' : ''}
      </p>
      <ul className="plain-list small" data-testid="workbench-files">
        {review.files.map((file) => (
          <li key={`${file.status}${file.path}`}>
            [{statusText[file.status] ?? file.status.trim()}] {file.path}
            {file.added !== null || file.deleted !== null
              ? ` +${file.added ?? 0} -${file.deleted ?? 0}`
              : ''}
          </li>
        ))}
      </ul>
    </>
  );
}
