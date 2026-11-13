import { useEffect, useState } from 'react';
import {
  mcpLimits,
  type McpResult,
  type McpServerView,
  type McpSnapshot,
  type McpTrust,
} from '../core/mcp';

const emptySnapshot: McpSnapshot = { servers: [], encryption: true };

interface Draft {
  previous: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string;
  cwd: string;
  url: string;
  env: string;
  headers: string;
  /** 编辑已有服务器时：密钥框留空就沿用原来的。 */
  keepSecrets: boolean;
}

const blankDraft: Draft = {
  previous: '',
  name: '',
  transport: 'stdio',
  command: '',
  args: '',
  cwd: '',
  url: '',
  env: '',
  headers: '',
  keepSecrets: false,
};

const stateText: Record<McpServerView['state'], string> = {
  off: '已关',
  starting: '连接中…',
  ready: '已连上',
  error: '出错',
};

/** 「KEY=VALUE」或「Key: Value」一行一条。 */
function parsePairs(text: string, separator: '=' | ':'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf(separator);
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (key !== '') out[key] = line.slice(index + 1).trim();
  }
  return out;
}

/**
 * 「外接工具（MCP）」：加服务器、从 Claude 的配置导入、开关、设放行方式。
 *
 * 密钥（环境变量、请求头的值）只进不出：面板只看得到名字，编辑时留空就沿用原来的。
 */
export function McpCard() {
  const [snapshot, setSnapshot] = useState<McpSnapshot>(emptySnapshot);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState<string>('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let alive = true;
    void window
      .companion!.mcpState()
      .then((next) => {
        if (alive) setSnapshot(next);
      })
      .catch(() => undefined);
    const off = window.companion!.onMcp((next) => setSnapshot(next));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const run = (action: Promise<McpResult>, after?: () => void): void => {
    setNotice('');
    void action.then((result) => {
      setError(result.ok ? '' : result.error);
      if (result.ok) after?.();
    });
  };

  const edit = (server: McpServerView): void => {
    setError('');
    setDraft({
      previous: server.name,
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: server.args.join('\n'),
      cwd: server.cwd,
      url: server.url,
      env: '',
      headers: '',
      keepSecrets: true,
    });
  };

  const save = (): void => {
    if (!draft) return;
    const env = parsePairs(draft.env, '=');
    const headers = parsePairs(draft.headers, ':');
    const typed = Object.keys(env).length > 0 || Object.keys(headers).length > 0;
    run(
      window.companion!.mcpSave({
        previous: draft.previous,
        name: draft.name,
        transport: draft.transport,
        command: draft.command,
        args: draft.args.split(/\r?\n/).filter((line) => line.trim() !== ''),
        cwd: draft.cwd,
        url: draft.url,
        // 编辑时没填就沿用原来的密钥；填了就整份替换。
        secrets: draft.keepSecrets && !typed ? null : { env, headers },
      }),
      () => setDraft(null),
    );
  };

  const importFrom = (source: 'claude-code' | 'claude-desktop'): void => {
    setError('');
    setNotice('');
    void window.companion!.mcpImport(source).then((result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const parts = [
        result.added.length > 0 ? `导入了 ${result.added.join('、')}` : '没有可导入的新服务器',
        result.skipped.length > 0 ? `跳过：${result.skipped.join('、')}` : '',
      ].filter((part) => part !== '');
      setNotice(`${parts.join('；')}。`);
    });
  };

  return (
    <section className="card" data-testid="ai-mcp">
      <div className="section-heading">
        <h2>外接工具（MCP）</h2>
        <span className="label">
          {snapshot.servers.length}/{mcpLimits.maxServers}
        </span>
      </div>
      <p className="muted">
        接上 MCP 服务器，它的工具就能在对话里用。默认每次调用都先问你（卡上有参数），
        信得过的可以整台或单个工具设成免确认。环境变量和请求头里的值当密钥，用系统加密保存，
        这里只显示名字。
      </p>
      {!snapshot.encryption && (
        <p className="error-text" role="alert">
          系统加密存储不可用：带密钥的服务器存不了。
        </p>
      )}
      {snapshot.servers.length > 0 && (
        <ul className="plain-list mcp-list" data-testid="mcp-servers">
          {snapshot.servers.map((server) => (
            <li key={server.name}>
              <div className="mcp-head">
                <b>{server.name}</b>
                <small className={server.state === 'error' ? 'error-text' : 'muted'}>
                  {stateText[server.state]}
                  {server.state === 'ready' ? ` · ${server.tools.length} 个工具` : ''}
                  {server.state === 'error' && server.error ? `：${server.error}` : ''}
                </small>
              </div>
              <div className="inline-actions mcp-actions">
                <label>
                  <input
                    type="checkbox"
                    aria-label={`启用 ${server.name}`}
                    checked={server.enabled}
                    onChange={(event) =>
                      run(window.companion!.mcpEnable(server.name, event.target.checked))
                    }
                  />{' '}
                  启用
                </label>
                <select
                  aria-label={`${server.name} 的放行方式`}
                  value={server.trust}
                  onChange={(event) =>
                    run(window.companion!.mcpTrust(server.name, event.target.value as McpTrust))
                  }
                >
                  <option value="ask">每次问我</option>
                  <option value="auto">免确认</option>
                </select>
                {server.tools.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setOpen(open === server.name ? '' : server.name)}
                  >
                    {open === server.name ? '收起工具' : '工具'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => run(window.companion!.mcpRestart(server.name))}
                >
                  重连
                </button>
                <button type="button" onClick={() => edit(server)}>
                  编辑
                </button>
                <button type="button" onClick={() => run(window.companion!.mcpRemove(server.name))}>
                  删除
                </button>
              </div>
              <small className="muted">
                {server.transport === 'http'
                  ? server.url
                  : [server.command, ...server.args].join(' ')}
                {server.envKeys.length + server.headerKeys.length > 0
                  ? ` · 密钥：${[...server.envKeys, ...server.headerKeys].join('、')}`
                  : ''}
              </small>
              {open === server.name && (
                <ul className="plain-list mcp-tools">
                  {server.tools.map((tool) => (
                    <li key={tool.name} className="inline-actions">
                      <label>
                        <input
                          type="checkbox"
                          aria-label={`${tool.name} 免确认`}
                          checked={tool.trust === 'auto'}
                          onChange={(event) =>
                            run(
                              window.companion!.mcpToolTrust(
                                server.name,
                                tool.name,
                                event.target.checked ? 'auto' : 'ask',
                              ),
                            )
                          }
                        />{' '}
                        <code>{tool.name}</code>
                      </label>
                      <small className="muted">{tool.description}</small>
                    </li>
                  ))}
                  <li>
                    <small className="muted">勾上的工具调用时不再问你。</small>
                  </li>
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {draft ? (
        <div className="mcp-form" data-testid="mcp-form">
          <label className="voice-row">
            <span>名字</span>
            <input
              aria-label="MCP 服务器名"
              value={draft.name}
              placeholder="如 github（字母数字、_ 和 -）"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label className="voice-row">
            <span>连接方式</span>
            <select
              aria-label="连接方式"
              value={draft.transport}
              onChange={(event) =>
                setDraft({ ...draft, transport: event.target.value as 'stdio' | 'http' })
              }
            >
              <option value="stdio">本机命令（stdio）</option>
              <option value="http">网址（Streamable HTTP）</option>
            </select>
          </label>
          {draft.transport === 'stdio' ? (
            <>
              <label className="voice-row">
                <span>命令</span>
                <input
                  aria-label="启动命令"
                  value={draft.command}
                  placeholder="如 npx、uvx、node 或完整路径"
                  onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                />
              </label>
              <label className="voice-row">
                <span>参数</span>
                <textarea
                  aria-label="启动参数"
                  rows={3}
                  value={draft.args}
                  placeholder={'一行一个，如\n-y\n@modelcontextprotocol/server-filesystem'}
                  onChange={(event) => setDraft({ ...draft, args: event.target.value })}
                />
              </label>
              <label className="voice-row">
                <span>工作目录</span>
                <input
                  aria-label="工作目录"
                  value={draft.cwd}
                  placeholder="可留空（芯伴的工作目录）"
                  onChange={(event) => setDraft({ ...draft, cwd: event.target.value })}
                />
              </label>
              <label className="voice-row">
                <span>环境变量</span>
                <textarea
                  aria-label="环境变量"
                  rows={2}
                  value={draft.env}
                  placeholder={
                    draft.keepSecrets ? '留空就沿用已保存的；填了会整份替换' : 'KEY=VALUE，一行一个'
                  }
                  onChange={(event) => setDraft({ ...draft, env: event.target.value })}
                />
              </label>
            </>
          ) : (
            <>
              <label className="voice-row">
                <span>地址</span>
                <input
                  aria-label="MCP 地址"
                  value={draft.url}
                  placeholder="https://…/mcp"
                  onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                />
              </label>
              <label className="voice-row">
                <span>请求头</span>
                <textarea
                  aria-label="请求头"
                  rows={2}
                  value={draft.headers}
                  placeholder={
                    draft.keepSecrets
                      ? '留空就沿用已保存的；填了会整份替换'
                      : 'Authorization: Bearer …，一行一个'
                  }
                  onChange={(event) => setDraft({ ...draft, headers: event.target.value })}
                />
              </label>
            </>
          )}
          <div className="button-row">
            <button className="primary" type="button" onClick={save}>
              保存并连接
            </button>
            <button type="button" onClick={() => setDraft(null)}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className="button-row">
          <button
            type="button"
            disabled={snapshot.servers.length >= mcpLimits.maxServers}
            onClick={() => {
              setError('');
              setDraft({ ...blankDraft });
            }}
          >
            加一台服务器
          </button>
          <button type="button" onClick={() => importFrom('claude-code')}>
            从 Claude Code 导入
          </button>
          <button type="button" onClick={() => importFrom('claude-desktop')}>
            从 Claude Desktop 导入
          </button>
        </div>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
