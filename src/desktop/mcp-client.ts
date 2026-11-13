import { appVersion } from '../core/version';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { mcpProtocolVersion } from '../core/mcp';
import { cmdShimArgs, killTree } from './delegate';

/**
 * 最小的 MCP 客户端：JSON-RPC 2.0 + 两种传输。
 *
 * 不用官方 SDK：它自带另一个大版本的 zod，和本项目的打架；而我们只用得到
 * initialize / tools/list / tools/call 这几个方法，自己写反而好审。
 *
 * - stdio：子进程，一行一条 JSON；Windows 上 npx/uvx 是 .cmd，走 cmd.exe 并用和派活同一套引号规则。
 * - http：Streamable HTTP，每条请求一个 POST，回应可能是 JSON 也可能是 SSE 流。
 */

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class McpError extends Error {}

export interface McpChannel {
  /** 发一条请求，等同 id 的回应。 */
  request(message: JsonRpcMessage, signal: AbortSignal): Promise<JsonRpcMessage>;
  notify(message: JsonRpcMessage): Promise<void>;
  close(): void;
  /** 通道自己断了（进程退出）时回调，带一句原因。 */
  onClose(listener: (reason: string) => void): void;
  /** 服务器主动发来的通知（如 tools/list_changed）。 */
  onNotification(listener: (method: string) => void): void;
}

/** stdio 一行的上限：再长就是对方在涂鸦，断开。 */
const maxLineBytes = 8 * 1024 * 1024;

/** 在 PATH 里找命令：Windows 上补 PATHEXT 里的扩展名（npx → npx.cmd）。找不到返回原样。 */
export async function resolveCommand(command: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (isAbsolute(command) || /[\\/]/.test(command)) return command;
  const windows = process.platform === 'win32';
  const exts = windows
    ? extname(command) !== ''
      ? ['']
      : (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext !== '')
    : [''];
  const dirs = (env['PATH'] ?? env['Path'] ?? '').split(delimiter).filter((dir) => dir !== '');
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext.toLowerCase());
      const info = await stat(candidate).catch(() => null);
      if (info?.isFile()) return candidate;
    }
  }
  return command;
}

export class StdioChannel implements McpChannel {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<
    string,
    { resolve: (message: JsonRpcMessage) => void; reject: (error: Error) => void }
  >();
  private closeListeners: ((reason: string) => void)[] = [];
  private notificationListeners: ((method: string) => void)[] = [];
  private stderrTail = '';
  private closed = false;

  constructor(
    private readonly options: {
      command: string;
      args: readonly string[];
      cwd: string;
      env: Readonly<Record<string, string>>;
    },
  ) {}

  async start(): Promise<void> {
    const env = { ...process.env, ...this.options.env, ELECTRON_RUN_AS_NODE: undefined };
    const resolved = await resolveCommand(this.options.command, env);
    const shim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
    const command = shim ? (process.env['ComSpec'] ?? 'cmd.exe') : resolved;
    const args = shim ? cmdShimArgs(resolved, this.options.args) : [...this.options.args];
    await new Promise<void>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(command, args, {
          cwd: this.options.cwd,
          env,
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: shim,
          stdio: 'pipe',
        });
      } catch {
        reject(new McpError(`启动不了 ${this.options.command}。`));
        return;
      }
      this.child = child;
      child.once('spawn', () => resolve());
      child.once('error', (error: NodeJS.ErrnoException) => {
        const reason =
          error.code === 'ENOENT'
            ? `找不到命令 ${this.options.command}（没装，或不在 PATH 里）。`
            : `启动不了 ${this.options.command}。`;
        reject(new McpError(reason));
        this.finish(reason);
      });
      child.stdout.on('data', (chunk: Buffer) => this.read(chunk));
      child.stderr.on('data', (chunk: Buffer) => {
        this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-600);
      });
      child.stdin.on('error', () => undefined);
      child.once('exit', (code) => {
        const tail = this.stderrTail.trim().split(/\r?\n/).slice(-3).join(' ').slice(-300);
        this.finish(`进程退出了（代码 ${code ?? '?'}）${tail ? `：${tail}` : ''}`);
      });
    });
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const index = this.buffer.indexOf(0x0a);
      if (index < 0) break;
      const line = this.buffer.subarray(0, index).toString('utf8').trim();
      this.buffer = this.buffer.subarray(index + 1);
      if (line !== '') this.dispatch(line);
    }
    if (this.buffer.length > maxLineBytes) {
      this.finish('对方输出了超长的一行，已断开。');
      this.close();
    }
  }

  private dispatch(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return; // 有些服务器把日志打到 stdout，认不出的行跳过。
    }
    if (typeof message !== 'object' || message === null) return;
    if (message.method !== undefined) {
      if (message.id !== undefined && message.id !== null) {
        // 服务器反过来问我们（sampling、roots…）：只应 ping，其余说不支持。
        void this.write(
          message.method === 'ping'
            ? { jsonrpc: '2.0', id: message.id, result: {} }
            : {
                jsonrpc: '2.0',
                id: message.id,
                error: { code: -32601, message: 'Method not found' },
              },
        );
        return;
      }
      for (const listener of this.notificationListeners) {
        try {
          listener(message.method);
        } catch {
          /* Observers must not break requests. */
        }
      }
      return;
    }
    const key = String(message.id);
    const waiter = this.pending.get(key);
    if (!waiter) return;
    this.pending.delete(key);
    waiter.resolve(message);
  }

  private write(message: JsonRpcMessage): Promise<void> {
    const child = this.child;
    if (!child || this.closed) return Promise.reject(new McpError('连接已断开。'));
    return new Promise((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) =>
        error ? reject(new McpError('写不进去，连接已断开。')) : resolve(),
      );
    });
  }

  request(message: JsonRpcMessage, signal: AbortSignal): Promise<JsonRpcMessage> {
    if (this.closed) return Promise.reject(new McpError('连接已断开。'));
    const key = String(message.id);
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(key);
        reject(new McpError('aborted'));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(key, {
        resolve: (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      });
      this.write(message).catch((error: Error) => {
        this.pending.delete(key);
        signal.removeEventListener('abort', onAbort);
        reject(error);
      });
    });
  }

  notify(message: JsonRpcMessage): Promise<void> {
    return this.write(message).catch(() => undefined);
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(new McpError(reason));
    this.pending.clear();
    for (const listener of this.closeListeners) listener(reason);
  }

  close(): void {
    const child = this.child;
    this.finish('已关闭。');
    if (child && child.exitCode === null) {
      child.stdin.end();
      killTree(child);
    }
  }

  onClose(listener: (reason: string) => void): void {
    this.closeListeners.push(listener);
  }

  onNotification(listener: (method: string) => void): void {
    this.notificationListeners.push(listener);
  }
}

/** 从 SSE 文本里取出各条 data 事件的 JSON。 */
export function sseMessages(text: string): JsonRpcMessage[] {
  const out: JsonRpcMessage[] = [];
  for (const block of text.replace(/\r\n?/g, '\n').split('\n\n')) {
    const data = block
      .split('\n')
      // 规范里不带冒号的裸 `data` 行等于空值。
      .filter((line) => line === 'data' || line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data.trim() === '') continue;
    try {
      const parsed = JSON.parse(data) as JsonRpcMessage | JsonRpcMessage[];
      out.push(
        ...(Array.isArray(parsed) ? parsed : [parsed]).filter(
          (item) =>
            item &&
            typeof item === 'object' &&
            item.jsonrpc === '2.0' &&
            (typeof item.id === 'number' ||
              typeof item.id === 'string' ||
              typeof item.method === 'string' ||
              // 对方解析不了请求时回 id:null 的错误，也要交给调用方。
              (item.id === null && 'error' in item)),
        ),
      );
    } catch {
      // 不是 JSON 的事件（心跳等）跳过
    }
  }
  return out;
}

/** 回应体上限：工具结果会被截到 1.2 万字，读 4MB 足够了。 */
const maxResponseBytes = 4 * 1024 * 1024;

export class HttpChannel implements McpChannel {
  private session = '';
  private protocol = '';
  private notificationListeners: ((method: string) => void)[] = [];

  constructor(
    private readonly url: string,
    private readonly headers: Readonly<Record<string, string>>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private requestHeaders(): Record<string, string> {
    return {
      ...this.headers,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.session ? { 'Mcp-Session-Id': this.session } : {}),
      ...(this.protocol ? { 'MCP-Protocol-Version': this.protocol } : {}),
    };
  }

  /** initialize 之后由客户端告诉它协商好的版本。 */
  setProtocol(version: string): void {
    this.protocol = version;
  }

  async request(message: JsonRpcMessage, signal: AbortSignal): Promise<JsonRpcMessage> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: this.requestHeaders(),
        body: JSON.stringify(message),
        signal,
        redirect: 'error',
      });
    } catch {
      if (signal.aborted) throw new McpError('aborted');
      throw new McpError('连不上这个地址。');
    }
    const session = response.headers.get('mcp-session-id');
    if (session) this.session = session.slice(0, 200);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpError(
        response.status === 401 || response.status === 403
          ? `对方拒绝了（HTTP ${response.status}）：多半是请求头里的 token 不对或过期了。`
          : `对方返回了 HTTP ${response.status}。`,
      );
    }
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) return this.readStream(response, message.id, signal);
    const text = await this.readCapped(response, signal);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new McpError('对方回的不是 JSON。');
    }
    const list = (Array.isArray(parsed) ? parsed : [parsed]) as JsonRpcMessage[];
    const hit = list.find(
      (item) =>
        item &&
        typeof item === 'object' &&
        item.jsonrpc === '2.0' &&
        item.method === undefined &&
        ((item.id === message.id && ('result' in item || 'error' in item)) ||
          (item.id === null && 'error' in item)),
    );
    if (!hit) throw new McpError('对方的回应里没有这条请求的结果。');
    return hit;
  }

  private async readCapped(response: Response, signal: AbortSignal): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const onAbort = (): void => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        if (signal.aborted) throw new McpError('aborted');
        const { done, value } = await reader.read();
        if (signal.aborted) throw new McpError('aborted');
        if (done) break;
        total += value.byteLength;
        if (total > maxResponseBytes) throw new McpError('对方回的内容太大了。');
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      signal.removeEventListener('abort', onAbort);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  /** SSE：边读边找，拿到同 id 的回应就停，不等流关闭。 */
  private async readStream(
    response: Response,
    id: JsonRpcMessage['id'],
    signal: AbortSignal,
  ): Promise<JsonRpcMessage> {
    const reader = response.body?.getReader();
    if (!reader) throw new McpError('对方的流是空的。');
    const decoder = new TextDecoder();
    let text = '';
    let total = 0;
    let previousCR = false;
    const onAbort = (): void => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        if (signal.aborted) throw new McpError('aborted');
        const { done, value } = await reader.read();
        if (signal.aborted) throw new McpError('aborted');
        if (done) break;
        total += value.byteLength;
        if (total > maxResponseBytes) throw new McpError('对方回的内容太大了。');
        let decoded = decoder.decode(value, { stream: true });
        if (decoded) {
          const endsCR = decoded.endsWith('\r');
          if (previousCR && decoded.startsWith('\n')) decoded = decoded.slice(1);
          previousCR = endsCR;
          text += decoded.replace(/\r\n?/g, '\n');
        }
        const cut = text.lastIndexOf('\n\n');
        if (cut < 0) continue;
        for (const message of sseMessages(text.slice(0, cut))) {
          if (message.method !== undefined && message.id !== undefined && message.id !== null) {
            // 服务端发来的请求（ping 等）：不回对方可能一直等。ping 回空结果，其余不支持。
            void this.notify(
              message.method === 'ping'
                ? { jsonrpc: '2.0', id: message.id, result: {} }
                : {
                    jsonrpc: '2.0',
                    id: message.id,
                    error: { code: -32601, message: 'Method not supported by client' },
                  },
            );
            continue;
          }
          if (message.method !== undefined && message.id === undefined) {
            for (const listener of this.notificationListeners) {
              try {
                listener(message.method);
              } catch {
                /* Observers must not break requests. */
              }
            }
          }
          if (
            message.method === undefined &&
            ((message.id === id && ('result' in message || 'error' in message)) ||
              (message.id === null && 'error' in message))
          )
            return message;
        }
        text = text.slice(cut + 2);
      }
      throw new McpError('流结束了也没等到结果。');
    } finally {
      signal.removeEventListener('abort', onAbort);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  async notify(message: JsonRpcMessage): Promise<void> {
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: this.requestHeaders(),
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      await response.body?.cancel().catch(() => undefined);
    } catch {
      // 通知丢了不致命
    }
  }

  close(): void {
    if (!this.session) return;
    // 告诉服务器这个会话不用了；失败无所谓。
    void this.fetchImpl(this.url, {
      method: 'DELETE',
      headers: this.requestHeaders(),
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
    })
      .then(async (response) => {
        await response.body?.cancel().catch(() => undefined);
      })
      .catch(() => undefined);
    this.session = '';
  }

  onClose(): void {
    // HTTP 没有常驻连接，靠每次请求自己报错。
  }

  onNotification(listener: (method: string) => void): void {
    this.notificationListeners.push(listener);
  }
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** 请求 + 超时 + 取消；错误统一成一句中文。 */
export class McpClient {
  private nextId = 1;
  serverName = '';

  constructor(private readonly channel: McpChannel) {}

  async call(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let reply: JsonRpcMessage;
    try {
      reply = await this.channel.request({ jsonrpc: '2.0', id, method, params }, combined);
    } catch (error) {
      if (combined.aborted) {
        // 告诉对方别干了；它不理也没关系。
        void this.channel.notify({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: id, reason: 'cancelled' },
        });
        throw new McpError(
          signal?.aborted ? '已取消。' : `等了 ${Math.round(timeoutMs / 1000)} 秒没回应。`,
        );
      }
      throw error instanceof McpError ? error : new McpError('请求失败。');
    }
    if (reply.error) {
      throw new McpError(`对方报错：${String(reply.error.message ?? '').slice(0, 300)}`);
    }
    return reply.result;
  }

  async initialize(timeoutMs: number): Promise<void> {
    const result = (await this.call(
      'initialize',
      {
        protocolVersion: mcpProtocolVersion,
        capabilities: {},
        clientInfo: { name: 'xinban', version: appVersion },
      },
      timeoutMs,
    )) as { protocolVersion?: unknown; serverInfo?: { name?: unknown } } | undefined;
    const version =
      typeof result?.protocolVersion === 'string' ? result.protocolVersion : mcpProtocolVersion;
    if (this.channel instanceof HttpChannel) this.channel.setProtocol(version);
    this.serverName = typeof result?.serverInfo?.name === 'string' ? result.serverInfo.name : '';
    await this.channel.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  /** 按 cursor 翻页取完工具表；最多翻 10 页。 */
  async listTools(timeoutMs: number): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = (await this.call('tools/list', cursor ? { cursor } : {}, timeoutMs)) as
        { tools?: unknown; nextCursor?: unknown } | undefined;
      if (Array.isArray(result?.tools)) {
        for (const raw of result.tools) {
          const tool = raw as McpToolInfo;
          if (typeof tool?.name === 'string' && tool.name.length <= 128) tools.push(tool);
        }
      }
      cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  callTool(name: string, args: unknown, timeoutMs: number, signal: AbortSignal): Promise<unknown> {
    return this.call('tools/call', { name, arguments: args ?? {} }, timeoutMs, signal);
  }

  close(): void {
    this.channel.close();
  }
}
