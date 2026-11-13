import { useEffect, useState } from 'react';
import {
  fileRootLimits,
  type FileChange,
  type FilesResult,
  type FilesSnapshot,
} from '../core/file-roots';
import { formatClock } from '../core/state';

const emptyFiles: FilesSnapshot = { roots: [], changes: [] };
const actionLabel: Record<FileChange['action'], string> = {
  created: '新建',
  modified: '修改',
  deleted: '删除',
};

/**
 * 「授权目录」：芯伴除了自己的沙盒，还能碰哪些目录；以及它改过什么、怎么撤销。
 *
 * 目录只能在这里加（模型没有「加目录」的工具）。默认只读，开了写权限也是每次写都先问你。
 */
export function FilesCard() {
  const [files, setFiles] = useState<FilesSnapshot>(emptyFiles);
  const [path, setPath] = useState('');
  const [writable, setWritable] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void window
      .companion!.filesState()
      .then((next) => {
        if (alive) setFiles(next);
      })
      .catch(() => undefined);
    const off = window.companion!.onFiles((next) => setFiles(next));
    return () => {
      alive = false;
      off();
    };
  }, []);
  const run = (action: Promise<FilesResult>, after?: () => void): void => {
    void action.then((result) => {
      setError(result.ok ? '' : result.error);
      if (result.ok) after?.();
    });
  };
  const add = (raw: string | null): void =>
    run(window.companion!.filesAdd(raw, writable), () => setPath(''));
  return (
    <section className="card" data-testid="ai-files">
      <div className="section-heading">
        <h2>授权目录（读写你的文件）</h2>
        <span className="label">
          {files.roots.length}/{fileRootLimits.maxRoots}
        </span>
      </div>
      <p className="muted">
        只有你在这里加的目录它才能碰。只读的只能看；开了写权限，每次新建或修改也都会先把改动给你看、等你允许，
        改前自动备份，可以在下面撤销。密钥类文件（.env、私钥、凭据）不读不写；.git、node_modules、
        工具配置和可执行文件不写。
      </p>
      {files.error && (
        <p className="error-text" role="alert">
          {files.error}
        </p>
      )}
      {files.roots.length > 0 && (
        <ul className="plain-list" data-testid="files-roots">
          {files.roots.map((root) => (
            <li key={root.name} className="inline-actions">
              <b>{root.name}</b>
              <small className="muted">{root.path}</small>
              <label>
                <input
                  type="checkbox"
                  aria-label={`允许写 ${root.name}`}
                  checked={root.writable}
                  onChange={(event) =>
                    run(window.companion!.filesWritable(root.name, event.target.checked))
                  }
                />{' '}
                可写
              </label>
              <button type="button" onClick={() => run(window.companion!.filesRemove(root.name))}>
                移除
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="voice-row">
        <span>目录</span>
        <input
          aria-label="授权目录路径"
          data-testid="files-path"
          placeholder="例如 D:\\notes；也可以点「选目录…」"
          value={path}
          onChange={(event) => {
            setPath(event.target.value);
            setError('');
          }}
        />
      </label>
      <div className="button-row">
        <label>
          <input
            type="checkbox"
            aria-label="新目录可写"
            checked={writable}
            onChange={(event) => setWritable(event.target.checked)}
          />{' '}
          允许创建和修改文件
        </label>
        <button
          className="primary"
          type="button"
          disabled={path.trim() === ''}
          onClick={() => add(path)}
        >
          添加
        </button>
        <button type="button" onClick={() => add(null)}>
          选目录…
        </button>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {files.changes.length > 0 && (
        <>
          <h3>最近的文件改动</h3>
          <ul className="plain-list" data-testid="files-changes">
            {files.changes.map((change) => (
              <li key={change.id} className="inline-actions">
                <small className={change.undone ? 'muted' : ''}>
                  {formatClock(change.at)} · {actionLabel[change.action]} · {change.path}
                  {change.undone
                    ? ' · 已撤销'
                    : change.status === 'prepared'
                      ? ' · 提交待核对'
                      : change.status !== 'applied'
                        ? ' · 旧记录/冲突，需人工核对'
                        : ''}
                </small>
                {!change.undone && change.status === 'applied' && (
                  <button type="button" onClick={() => run(window.companion!.filesUndo(change.id))}>
                    撤销
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
