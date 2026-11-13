import { readFile } from 'node:fs/promises';
import {
  effectiveTrust,
  emptyMcpConfig,
  mcpLimits,
  mcpResultText,
  mcpServerProblem,
  mcpToolName,
  mcpToolSpec,
  normalizeMcpConfig,
  normalizeSecrets,
  parseMcpImport,
  redactSecrets,
  type McpConfig,
  type McpImportResult,
  type McpResult,
  type McpServerInput,
  type McpSecrets,
  type McpServerConfig,
  type McpServerView,
  type McpSnapshot,
  type McpState,
  type McpTrust,
} from '../core/mcp';
import type { AiCrypto } from './ai-credentials';
import { writeJsonAtomic } from './atomic';
import {
  HttpChannel,
  McpClient,
  McpError,
  StdioChannel,
  type McpChannel,
  type McpToolInfo,
} from './mcp-client';

interface Running {
  state: McpState;
  error: string;
  tools: McpToolInfo[];
  client: McpClient | null;
  /** 每次重启 +1；旧连接迟到的回调对不上就丢掉。 */
  epoch: number;
}

export type ChannelFactory = (
  config: McpServerConfig,
  secrets: McpSecrets,
  cwd: string,
) => Promise<McpChannel>;

/** 真实的通道：stdio 起子进程，http 直接连。测试里可以换。 */
export const defaultChannelFactory: ChannelFactory = async (config, secrets, cwd) => {
  if (config.transport === 'http') return new HttpChannel(config.url, secrets.headers);
  const channel = new StdioChannel({
    command: config.command,
    args: config.args,
    cwd: config.cwd || cwd,
    env: secrets.env,
  });
  await channel.start();
  return channel;
};

export interface McpCallOutcome {
  ok: true;
  text: string;
  isError: boolean;
}

/**
 * MCP 服务器管理：配置与密钥的存取、连接的启停、把工具表交给模型、代为调用。
 *
 * 密钥（env/headers 的值）用系统加密另存一个文件，只在启动连接时解密进内存；
 * 快照里只有名字。加密不可用时拒绝保存带密钥的服务器，不降级成明文。
 */
export class McpService {
  private config: McpConfig = emptyMcpConfig();
  private secrets = new Map<string, McpSecrets>();
  private readonly running = new Map<string, Running>();
  private readonly listeners = new Set<(snapshot: McpSnapshot) => void>();
  /** 工具名 → (服务器, 原始工具名)；每次工具表变化时重建。 */
  private routes = new Map<string, { server: string; tool: string }>();
  private specsCache: Record<string, unknown>[] = [];

  constructor(
    private readonly paths: { config: string; secrets: string },
    private readonly crypto: AiCrypto,
    private readonly workspaceRoot: string,
    private readonly channels: ChannelFactory = defaultChannelFactory,
    /** 只记服务器名、工具名、成败与耗时；参数、结果、密钥都不进日志。 */
    private readonly log: (
      event: string,
      fields: Record<string, string | number | boolean | undefined>,
    ) => void = () => undefined,
  ) {}

  async load(): Promise<void> {
    try {
      this.config = normalizeMcpConfig(JSON.parse(await readFile(this.paths.config, 'utf8')));
    } catch {
      this.config = emptyMcpConfig();
    }
    this.secrets = new Map();
    try {
      const stored = JSON.parse(await readFile(this.paths.secrets, 'utf8')) as {
        version?: unknown;
        data?: unknown;
      };
      if (stored.version === 1 && typeof stored.data === 'string') {
        const plain = JSON.parse(this.crypto.decrypt(Buffer.from(stored.data, 'base64'))) as Record<
          string,
          unknown
        >;
        for (const [name, value] of Object.entries(plain)) {
          this.secrets.set(name, normalizeSecrets(value));
        }
      }
    } catch {
      // 没有、坏了或解不开（换了电脑/用户）：当没有密钥，连接时对方会报未授权。
    }
    for (const server of this.config.servers) {
      this.running.set(server.name, { state: 'off', error: '', tools: [], client: null, epoch: 0 });
    }
  }

  /** 启动所有开着的服务器；各自独立，一台起不来不影响别的。 */
  startAll(): void {
    for (const server of this.config.servers) {
      if (server.enabled) void this.start(server.name);
    }
  }

  snapshot(): McpSnapshot {
    return {
      encryption: this.crypto.available(),
      servers: this.config.servers.map((server) => this.view(server)),
    };
  }

  subscribe(listener: (snapshot: McpSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private view(server: McpServerConfig): McpServerView {
    const run = this.running.get(server.name);
    return {
      ...server,
      args: [...server.args],
      toolTrust: { ...server.toolTrust },
      envKeys: [...server.envKeys],
      headerKeys: [...server.headerKeys],
      state: run?.state ?? 'off',
      error: run?.error ?? '',
      tools: (run?.tools ?? []).map((tool) => ({
        name: tool.name,
        description: (tool.description ?? '').slice(0, 300),
        trust: effectiveTrust(server, tool.name),
      })),
    };
  }

  private publish(): void {
    this.rebuildRoutes();
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private rebuildRoutes(): void {
    const routes = new Map<string, { server: string; tool: string }>();
    const specs: Record<string, unknown>[] = [];
    for (const server of this.config.servers) {
      const run = this.running.get(server.name);
      if (!server.enabled || run?.state !== 'ready') continue;
      for (const tool of run.tools) {
        if (specs.length >= mcpLimits.maxTools) break;
        const name = mcpToolName(server.name, tool.name);
        if (routes.has(name)) continue; // 截断后撞名的，留第一个
        routes.set(name, { server: server.name, tool: tool.name });
        specs.push(mcpToolSpec(server.name, tool));
      }
    }
    this.routes = routes;
    this.specsCache = specs;
  }

  /** 给模型的工具表（只含已连上的）。 */
  specs(): readonly Record<string, unknown>[] {
    return this.specsCache;
  }

  describe(name: string): { server: string; tool: string; trust: McpTrust } | null {
    const route = this.routes.get(name);
    if (!route) return null;
    const server = this.config.servers.find((item) => item.name === route.server);
    if (!server) return null;
    return { ...route, trust: effectiveTrust(server, route.tool) };
  }

  private secretsOf(name: string): McpSecrets {
    return this.secrets.get(name) ?? { env: {}, headers: {} };
  }

  async start(name: string): Promise<void> {
    const server = this.config.servers.find((item) => item.name === name);
    if (!server) return;
    const previous = this.running.get(name);
    previous?.client?.close();
    const epoch = (previous?.epoch ?? 0) + 1;
    const run: Running = { state: 'starting', error: '', tools: [], client: null, epoch };
    this.running.set(name, run);
    this.publish();
    const current = () => this.running.get(name)?.epoch === epoch;
    const secrets = this.secretsOf(name);
    const started = Date.now();
    try {
      const channel = await this.channels(server, secrets, this.workspaceRoot);
      const client = new McpClient(channel);
      if (!current()) {
        client.close();
        return;
      }
      run.client = client;
      channel.onClose((reason) => {
        if (!current() || run.state === 'off') return;
        run.state = 'error';
        run.error = redactSecrets(reason, secrets);
        run.tools = [];
        run.client = null;
        this.log('mcp-down', { server: name });
        this.publish();
      });
      channel.onNotification((method) => {
        if (method === 'notifications/tools/list_changed' && current())
          void this.refreshTools(name);
      });
      await client.initialize(mcpLimits.startTimeoutMs);
      const tools = await client.listTools(mcpLimits.listTimeoutMs);
      if (!current()) return;
      run.tools = tools;
      run.state = 'ready';
      this.log('mcp-ready', { server: name, tools: tools.length, ms: Date.now() - started });
    } catch (error) {
      if (!current()) return;
      run.client?.close();
      run.client = null;
      run.state = 'error';
      run.error = redactSecrets(
        error instanceof McpError ? error.message : '连不上。',
        secrets,
      ).slice(0, 400);
      this.log('mcp-failed', { server: name, ms: Date.now() - started });
    }
    this.publish();
  }

  private async refreshTools(name: string): Promise<void> {
    const run = this.running.get(name);
    if (!run?.client || run.state !== 'ready') return;
    try {
      run.tools = await run.client.listTools(mcpLimits.listTimeoutMs);
      this.publish();
    } catch {
      // 保留旧表
    }
  }

  stop(name: string): void {
    const run = this.running.get(name);
    if (!run) return;
    run.client?.close();
    this.running.set(name, {
      state: 'off',
      error: '',
      tools: [],
      client: null,
      epoch: run.epoch + 1,
    });
    this.publish();
  }

  stopAll(): void {
    for (const name of [...this.running.keys()]) {
      const run = this.running.get(name)!;
      run.client?.close();
      this.running.set(name, { ...run, state: 'off', client: null, epoch: run.epoch + 1 });
    }
  }

  async call(
    name: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<McpCallOutcome | { ok: false; error: string }> {
    const route = this.routes.get(name);
    if (!route) return { ok: false, error: '这个工具现在不可用（服务器没连上或已关掉）。' };
    const run = this.running.get(route.server);
    if (!run?.client || run.state !== 'ready') {
      return { ok: false, error: `${route.server} 现在没连上。` };
    }
    const started = Date.now();
    try {
      const result = await run.client.callTool(route.tool, args, mcpLimits.callTimeoutMs, signal);
      const { text, isError } = mcpResultText(result);
      this.log('mcp-call', {
        server: route.server,
        tool: route.tool,
        ok: !isError,
        ms: Date.now() - started,
      });
      return { ok: true, text: redactSecrets(text, this.secretsOf(route.server)), isError };
    } catch (error) {
      this.log('mcp-call', {
        server: route.server,
        tool: route.tool,
        ok: false,
        ms: Date.now() - started,
      });
      const message = error instanceof McpError ? error.message : '调用失败。';
      return { ok: false, error: redactSecrets(message, this.secretsOf(route.server)) };
    }
  }

  // ---- 面板操作 ----

  async save(input: McpServerInput): Promise<McpResult> {
    const previousName = input.previous ?? '';
    const existing = this.config.servers.find((item) => item.name === previousName);
    const secrets = input.secrets
      ? normalizeSecrets(input.secrets)
      : existing
        ? this.secretsOf(existing.name)
        : { env: {}, headers: {} };
    const config: McpServerConfig = {
      name: input.name.trim(),
      transport: input.transport === 'http' ? 'http' : 'stdio',
      command: input.command.trim(),
      args: input.args.map((arg) => arg.trim()).filter((arg) => arg !== ''),
      cwd: input.cwd.trim(),
      url: input.url.trim(),
      enabled: existing?.enabled ?? true,
      trust: existing?.trust ?? 'ask',
      toolTrust: existing?.toolTrust ?? {},
      envKeys: Object.keys(secrets.env),
      headerKeys: Object.keys(secrets.headers),
    };
    const problem = mcpServerProblem(config);
    if (problem !== '') return { ok: false, error: problem };
    const clash = this.config.servers.find(
      (item) => item.name.toLowerCase() === config.name.toLowerCase() && item !== existing,
    );
    if (clash) return { ok: false, error: '已经有同名的服务器了。' };
    if (!existing && this.config.servers.length >= mcpLimits.maxServers) {
      return { ok: false, error: `最多 ${mcpLimits.maxServers} 台。` };
    }
    const servers = existing
      ? this.config.servers.map((item) => (item === existing ? config : item))
      : [...this.config.servers, config];
    const nextSecrets = new Map(this.secrets);
    if (existing) nextSecrets.delete(existing.name);
    nextSecrets.set(config.name, secrets);
    const saved = await this.persist({ version: 1, servers }, nextSecrets);
    if (!saved.ok) return saved;
    if (existing && existing.name !== config.name) {
      this.stop(existing.name);
      this.running.delete(existing.name);
    }
    this.log('mcp-save', { server: config.name, transport: config.transport });
    if (config.enabled) void this.start(config.name);
    else this.publish();
    return { ok: true };
  }

  async remove(name: string): Promise<McpResult> {
    if (!this.config.servers.some((item) => item.name === name))
      return { ok: false, error: '没有这台服务器。' };
    const nextSecrets = new Map(this.secrets);
    nextSecrets.delete(name);
    const saved = await this.persist(
      { version: 1, servers: this.config.servers.filter((item) => item.name !== name) },
      nextSecrets,
    );
    if (!saved.ok) return saved;
    this.stop(name);
    this.running.delete(name);
    this.publish();
    return { ok: true };
  }

  async setEnabled(name: string, enabled: boolean): Promise<McpResult> {
    const saved = await this.update(name, (server) => ({ ...server, enabled }));
    if (!saved.ok) return saved;
    if (enabled) void this.start(name);
    else this.stop(name);
    return saved;
  }

  setTrust(name: string, trust: McpTrust): Promise<McpResult> {
    return this.update(name, (server) => ({ ...server, trust, toolTrust: {} }));
  }

  /** trust 为 null：去掉单独设置，跟整台。 */
  setToolTrust(name: string, tool: string, trust: McpTrust | null): Promise<McpResult> {
    return this.update(name, (server) => {
      const toolTrust = { ...server.toolTrust };
      if (trust === null || trust === server.trust) delete toolTrust[tool];
      else toolTrust[tool] = trust;
      return { ...server, toolTrust };
    });
  }

  /** 从 Claude 的配置文件导入。返回导入了哪些、跳过了哪些（只有名字，不含密钥）。 */
  async importFrom(path: string): Promise<McpImportResult> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return { ok: false, error: '没找到配置文件，或者它不是合法的 JSON。' };
    }
    const { servers, skipped } = parseMcpImport(
      raw,
      this.config.servers.map((item) => item.name),
    );
    if (servers.length === 0) {
      return { ok: true, added: [], skipped };
    }
    const nextSecrets = new Map(this.secrets);
    for (const item of servers) nextSecrets.set(item.config.name, item.secrets);
    const saved = await this.persist(
      { version: 1, servers: [...this.config.servers, ...servers.map((item) => item.config)] },
      nextSecrets,
    );
    if (!saved.ok) return saved;
    for (const item of servers) {
      this.running.set(item.config.name, {
        state: 'off',
        error: '',
        tools: [],
        client: null,
        epoch: 0,
      });
      void this.start(item.config.name);
    }
    this.log('mcp-import', { added: servers.length, skipped: skipped.length });
    return { ok: true, added: servers.map((item) => item.config.name), skipped };
  }

  private async update(
    name: string,
    change: (server: McpServerConfig) => McpServerConfig,
  ): Promise<McpResult> {
    const existing = this.config.servers.find((item) => item.name === name);
    if (!existing) return { ok: false, error: '没有这台服务器。' };
    const saved = await this.persist(
      {
        version: 1,
        servers: this.config.servers.map((item) => (item === existing ? change(item) : item)),
      },
      this.secrets,
    );
    if (saved.ok) this.publish();
    return saved;
  }

  private async persist(next: McpConfig, secrets: Map<string, McpSecrets>): Promise<McpResult> {
    const record: Record<string, McpSecrets> = {};
    for (const server of next.servers) {
      const value = secrets.get(server.name);
      if (value && (Object.keys(value.env).length > 0 || Object.keys(value.headers).length > 0)) {
        record[server.name] = value;
      }
    }
    const hasSecrets = Object.keys(record).length > 0;
    if (hasSecrets && !this.crypto.available()) {
      return { ok: false, error: '系统加密存储不可用，不能保存带密钥的服务器（不会以明文保存）。' };
    }
    try {
      await writeJsonAtomic(this.paths.config, next);
      await writeJsonAtomic(this.paths.secrets, {
        version: 1,
        data: hasSecrets ? this.crypto.encrypt(JSON.stringify(record)).toString('base64') : '',
      });
    } catch {
      return { ok: false, error: '保存失败。' };
    }
    this.config = next;
    this.secrets = new Map(Object.entries(record));
    for (const server of next.servers) {
      if (!this.running.has(server.name)) {
        this.running.set(server.name, {
          state: 'off',
          error: '',
          tools: [],
          client: null,
          epoch: 0,
        });
      }
    }
    return { ok: true };
  }
}
