import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  mcpParameters,
  mcpPrompt,
  mcpResultText,
  mcpServerProblem,
  mcpToolName,
  normalizeMcpConfig,
  parseMcpImport,
  redactSecrets,
  type McpServerConfig,
} from '../src/core/mcp';
import {
  HttpChannel,
  McpClient,
  StdioChannel,
  resolveCommand,
  sseMessages,
} from '../src/desktop/mcp-client';
import { McpService, type ChannelFactory } from '../src/desktop/mcp';
import type { AiCrypto } from '../src/desktop/ai-credentials';
import type { CommandResult, Snapshot } from '../src/core/schema';
import type { ConfirmRequest } from '../src/core/confirm';
import { ToolExecutor, type ToolHost } from '../src/desktop/tools';

const fixture = resolve(__dirname, 'fixtures', 'fake-mcp-server.mjs');
const directories: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

async function temp(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'xinban-mcp-'));
  directories.push(directory);
  return directory;
}

/** 可逆的假加密：字节反转。够验证「落盘的不是明文」。 */
const crypto: AiCrypto = {
  available: () => true,
  encrypt: (plain) => Buffer.from(plain, 'utf8').reverse(),
  decrypt: (payload) => Buffer.from(payload).reverse().toString('utf8'),
};

const stdioServer = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name: 'fake',
  transport: 'stdio',
  command: process.execPath,
  args: [fixture],
  cwd: '',
  url: '',
  enabled: true,
  trust: 'ask',
  toolTrust: {},
  envKeys: [],
  headerKeys: [],
  ...over,
});

describe('MCP：配置与导入', () => {
  it('命令、地址的校验', () => {
    expect(mcpServerProblem(stdioServer())).toBe('');
    expect(mcpServerProblem(stdioServer({ name: 'bad name' }))).not.toBe('');
    expect(mcpServerProblem(stdioServer({ command: 'npx && calc' }))).not.toBe('');
    const http = stdioServer({ transport: 'http', command: '' });
    expect(mcpServerProblem({ ...http, url: 'https://mcp.example.com/mcp' })).toBe('');
    expect(mcpServerProblem({ ...http, url: 'http://localhost:3000/mcp' })).toBe('');
    expect(mcpServerProblem({ ...http, url: 'http://mcp.example.com/mcp' })).not.toBe('');
    expect(mcpServerProblem({ ...http, url: 'https://u:p@mcp.example.com/' })).not.toBe('');
  });

  it('从 Claude 的 mcpServers 导入：env/headers 进密钥，SSE 与重名跳过', () => {
    const { servers, skipped } = parseMcpImport(
      {
        mcpServers: {
          github: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: { GITHUB_TOKEN: 'ghp_secret' },
          },
          'my docs': {
            type: 'http',
            url: 'https://docs.example.com/mcp',
            headers: { Authorization: 'Bearer t' },
          },
          old: { type: 'sse', url: 'https://old.example.com/sse' },
          fake: { command: 'node' },
        },
      },
      ['fake'],
    );
    expect(servers.map((item) => item.config.name)).toEqual(['github', 'my-docs']);
    expect(servers[0]!.config.envKeys).toEqual(['GITHUB_TOKEN']);
    expect(servers[0]!.secrets.env).toEqual({ GITHUB_TOKEN: 'ghp_secret' });
    expect(JSON.stringify(servers[0]!.config)).not.toContain('ghp_secret');
    expect(servers[1]!.config.transport).toBe('http');
    expect(servers[1]!.config.trust).toBe('ask');
    expect(skipped.join(' ')).toContain('old');
    expect(skipped.join(' ')).toContain('fake');
  });

  it('坏配置里认不出的条目丢掉', () => {
    const config = normalizeMcpConfig({
      servers: [
        stdioServer(),
        stdioServer(),
        { name: 'x y' },
        null,
        stdioServer({ name: 'b', trust: 'auto' as const }),
      ],
    });
    expect(config.servers.map((server) => [server.name, server.trust])).toEqual([
      ['fake', 'ask'],
      ['b', 'auto'],
    ]);
  });

  it('工具名、参数 schema、结果、打码', () => {
    expect(mcpToolName('my.srv', 'read file')).toBe('mcp__my_srv__read_file');
    expect(mcpToolName('a', 'x'.repeat(100))).toHaveLength(64);
    expect(mcpParameters({ $schema: 'x', type: 'object' })).toEqual({
      type: 'object',
      properties: {},
    });
    expect(mcpParameters({ type: 'string' })).toEqual({ type: 'object', properties: {} });
    expect(
      mcpResultText({
        content: [
          { type: 'text', text: 'a' },
          { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        ],
      }),
    ).toEqual({ text: 'a\n[图片 image/png，未展开]', isError: false });
    expect(mcpResultText({ isError: true, content: [] }).isError).toBe(true);
    expect(redactSecrets('bad token ghp_secret', { env: { T: 'ghp_secret' }, headers: {} })).toBe(
      'bad token ***',
    );
    expect(
      sseMessages('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'),
    ).toHaveLength(1);
  });
});

// 这两组要起真实的子进程：全量并行跑时机器很忙，默认 5 秒不够。
describe('MCP：stdio 与 HTTP 连接', { timeout: 20_000 }, () => {
  it('stdio：握手、翻页取工具、调用、超时、进程退出', async () => {
    const channel = new StdioChannel({
      command: process.execPath,
      args: [fixture],
      cwd: tmpdir(),
      env: { FAKE_TOKEN: 'tok-123' },
    });
    await channel.start();
    const client = new McpClient(channel);
    cleanups.push(() => client.close());
    await client.initialize(10_000);
    expect(client.serverName).toBe('fake');
    const tools = await client.listTools(10_000);
    expect(tools.map((tool) => tool.name)).toEqual(['echo', 'whoami', 'broken', 'slow']);
    const signal = new AbortController().signal;
    expect(mcpResultText(await client.callTool('echo', { text: '你好' }, 5_000, signal)).text).toBe(
      'echo:你好',
    );
    expect(mcpResultText(await client.callTool('whoami', {}, 5_000, signal)).text).toBe(
      'token=tok-123',
    );
    await expect(client.callTool('slow', {}, 300, signal)).rejects.toThrow(/没回应/);
    const closed = new Promise<string>((done) => channel.onClose(done));
    await expect(client.call('exit-now', {}, 2_000)).rejects.toThrow(/退出/);
    expect(await closed).toContain('3');
  });

  it.skipIf(process.platform !== 'win32')(
    'stdio：Windows 上经 .cmd 外壳启动（npx/uvx 就是这样），路径带空格也行',
    async () => {
      const dir = join(await temp(), 'with space');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'fake-mcp.cmd'), '@"%FAKE_NODE%" "%FAKE_SCRIPT%" %*\r\n', 'utf8');
      expect(await resolveCommand('fake-mcp', { ...process.env, PATH: dir })).toMatch(
        /fake-mcp\.cmd$/i,
      );
      const channel = new StdioChannel({
        command: join(dir, 'fake-mcp.cmd'),
        args: ['--flag', 'a b&c'],
        cwd: dir,
        env: { FAKE_NODE: process.execPath, FAKE_SCRIPT: fixture },
      });
      await channel.start();
      const client = new McpClient(channel);
      cleanups.push(() => client.close());
      await client.initialize(10_000);
      expect((await client.listTools(10_000)).length).toBe(4);
    },
  );

  it('stdio：命令不存在时说清楚', async () => {
    const channel = new StdioChannel({
      command: 'xinban-no-such-mcp',
      args: [],
      cwd: tmpdir(),
      env: {},
    });
    await expect(channel.start()).rejects.toThrow(/找不到命令/);
  });

  async function httpServer(
    mode: 'json' | 'sse',
  ): Promise<{ url: string; seen: IncomingMessage[] }> {
    const seen: IncomingMessage[] = [];
    const server: Server = createServer((request, response) => {
      seen.push(request);
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      request.on('end', () => {
        if (request.headers['authorization'] !== 'Bearer good') {
          response.writeHead(401).end();
          return;
        }
        const message = JSON.parse(body || '{}') as { id?: number; method?: string };
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const result =
          message.method === 'initialize'
            ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'web' } }
            : message.method === 'tools/list'
              ? { tools: [{ name: 'search', inputSchema: { type: 'object' } }] }
              : { content: [{ type: 'text', text: 'found it' }] };
        const reply = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
        if (mode === 'sse') {
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 's-1' });
          response.write(': ping\n\n');
          response.write(`event: message\ndata: ${reply}\n\n`);
          // 不结束流：客户端拿到结果就该自己停。
        } else {
          response.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 's-1' });
          response.end(reply);
        }
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    cleanups.push(() => {
      server.closeAllConnections();
      server.close();
    });
    const address = server.address() as { port: number };
    return { url: `http://127.0.0.1:${address.port}/mcp`, seen };
  }

  for (const mode of ['json', 'sse'] as const) {
    it(`HTTP（${mode}）：带请求头、记住会话、调用`, async () => {
      const { url, seen } = await httpServer(mode);
      const client = new McpClient(new HttpChannel(url, { Authorization: 'Bearer good' }));
      await client.initialize(5_000);
      expect((await client.listTools(5_000)).map((tool) => tool.name)).toEqual(['search']);
      const result = await client.callTool(
        'search',
        { q: 'x' },
        5_000,
        new AbortController().signal,
      );
      expect(mcpResultText(result).text).toBe('found it');
      expect(seen.at(-1)!.headers['mcp-session-id']).toBe('s-1');
      expect(seen.at(-1)!.headers['mcp-protocol-version']).toBe('2025-06-18');
    });
  }

  it('HTTP：token 不对时说清楚', async () => {
    const { url } = await httpServer('json');
    const client = new McpClient(new HttpChannel(url, { Authorization: 'Bearer bad' }));
    await expect(client.initialize(5_000)).rejects.toThrow(/token/);
  });
});

describe('MCP：服务与工具层', { timeout: 20_000 }, () => {
  async function service(channels?: ChannelFactory) {
    const dir = await temp();
    const paths = {
      config: join(dir, 'mcp-servers-v1.json'),
      secrets: join(dir, 'mcp-secrets-v1.json'),
    };
    const mcp = new McpService(paths, crypto, dir, channels);
    cleanups.push(() => mcp.stopAll());
    await mcp.load();
    return { mcp, paths, dir };
  }

  const ready = (mcp: McpService, name: string) =>
    new Promise<void>((done, fail) => {
      const check = () => {
        const server = mcp.snapshot().servers.find((item) => item.name === name);
        if (server?.state === 'ready') done();
        if (server?.state === 'error') fail(new Error(server.error));
      };
      mcp.subscribe(check);
      check();
    });

  it('保存带密钥的服务器：落盘与快照里都没有明文；连上后工具进工具表', async () => {
    const { mcp, paths } = await service();
    const saved = await mcp.save({
      name: 'fake',
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      cwd: '',
      url: '',
      secrets: { env: { FAKE_TOKEN: 'tok-secret-1' }, headers: {} },
    });
    expect(saved).toEqual({ ok: true });
    await ready(mcp, 'fake');
    expect(await readFile(paths.config, 'utf8')).not.toContain('tok-secret-1');
    expect(await readFile(paths.secrets, 'utf8')).not.toContain('tok-secret-1');
    expect(JSON.stringify(mcp.snapshot())).not.toContain('tok-secret-1');
    expect(mcp.snapshot().servers[0]!.envKeys).toEqual(['FAKE_TOKEN']);
    expect(mcp.specs().map((spec) => spec['name'])).toContain('mcp__fake__echo');
    // 对方把 token 原样回显：交给模型前打码。
    const who = await mcp.call('mcp__fake__whoami', {}, new AbortController().signal);
    expect(who).toEqual({ ok: true, text: 'token=***', isError: false });

    // 重启后密钥还在（解密回来）
    const again = new McpService(paths, crypto, tmpdir());
    cleanups.push(() => again.stopAll());
    await again.load();
    again.startAll();
    await ready(again, 'fake');
    const whoAgain = await again.call('mcp__fake__whoami', {}, new AbortController().signal);
    expect(whoAgain.ok && whoAgain.text).toBe('token=***');
  });

  it('系统加密不可用时拒绝保存密钥', async () => {
    const dir = await temp();
    const mcp = new McpService(
      { config: join(dir, 'c.json'), secrets: join(dir, 's.json') },
      { ...crypto, available: () => false },
      dir,
    );
    await mcp.load();
    const result = await mcp.save({
      name: 'x',
      transport: 'http',
      command: '',
      args: [],
      cwd: '',
      url: 'https://x.example.com/mcp',
      secrets: { env: {}, headers: { Authorization: 'Bearer t' } },
    });
    expect(result.ok).toBe(false);
  });

  it('工具层：默认先问，拒绝就不调；免确认直接跑；结果包成不可信数据', async () => {
    const { mcp, dir } = await service();
    await mcp.save({
      name: 'fake',
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      cwd: '',
      url: '',
      secrets: null,
    });
    await ready(mcp, 'fake');
    const asked: ConfirmRequest[] = [];
    let allow = false;
    const host: ToolHost = {
      postJson: () => Promise.resolve({ ok: true, status: 200, data: {} }),
      snapshot: () =>
        ({ state: { todos: [], timer: null }, storageError: null }) as unknown as Snapshot,
      dispatch: () => Promise.resolve({ ok: true } as CommandResult),
      memory: {
        remember: () => Promise.resolve({ ok: true, output: '', note: '' }),
        forget: () => Promise.resolve({ removed: [], candidates: [] }),
        search: () => [],
      },
      confirm: (request) => {
        asked.push(request);
        return Promise.resolve(allow);
      },
      mcp: {
        describe: (name) => mcp.describe(name),
        call: (name, args, signal) => mcp.call(name, args, signal),
      },
    };
    const executor = new ToolExecutor(host, dir);
    const call = (name: string, args: Record<string, unknown>) =>
      executor.run(
        { callId: 'c', name, arguments: JSON.stringify(args) },
        new AbortController().signal,
      );

    const denied = await call('mcp__fake__echo', { text: 'hi' });
    expect(denied.output).toContain('没有允许');
    expect(asked[0]).toMatchObject({ tool: 'mcp', title: '想用 fake 的 echo' });
    expect(asked[0]!.detail).toContain('"text": "hi"');

    allow = true;
    const allowed = await call('mcp__fake__echo', { text: 'hi' });
    expect(allowed.output).toContain('echo:hi');
    expect(allowed.output).toContain('不可信数据');
    expect(allowed.trace.label).toBe('MCP：fake · echo');

    await mcp.setToolTrust('fake', 'echo', 'auto');
    const before = asked.length;
    expect((await call('mcp__fake__echo', { text: 'x' })).output).toContain('echo:x');
    expect(asked).toHaveLength(before);

    const broken = await call('mcp__fake__broken', {});
    expect(broken.output).toContain('工具报告了错误');

    // 关掉后工具从工具表里消失，模型再叫就是「没有这个工具」
    await mcp.setEnabled('fake', false);
    expect(mcp.specs()).toHaveLength(0);
    expect((await call('mcp__fake__echo', { text: 'x' })).trace.status).toBe('error');
    expect(mcpPrompt(mcp.snapshot().servers)).toBe('');
  });

  it('从配置文件导入并自动连上，默认逐次确认', async () => {
    const { mcp, dir } = await service();
    const source = join(dir, 'claude_desktop_config.json');
    await writeFile(
      source,
      JSON.stringify({
        mcpServers: {
          fake: { command: process.execPath, args: [fixture], env: { FAKE_TOKEN: 'z' } },
        },
      }),
      'utf8',
    );
    const result = await mcp.importFrom(source);
    expect(result).toEqual({ ok: true, added: ['fake'], skipped: [] });
    await ready(mcp, 'fake');
    expect(mcp.describe('mcp__fake__echo')).toEqual({ server: 'fake', tool: 'echo', trust: 'ask' });
    expect(mcpPrompt(mcp.snapshot().servers)).toContain('fake：4 个工具');
    expect((await mcp.importFrom(join(dir, 'missing.json'))).ok).toBe(false);
    expect(await mcp.remove('fake')).toEqual({ ok: true });
    expect(mcp.snapshot().servers).toHaveLength(0);
  });
});
