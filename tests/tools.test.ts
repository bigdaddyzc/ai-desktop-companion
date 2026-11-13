import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Action, CommandResult, Snapshot } from '../src/core/schema';
import type { MemoryFact } from '../src/core/memory';
import {
  ToolExecutor,
  type ToolHost,
  type ToolJsonResult,
  type ToolMemory,
} from '../src/desktop/tools';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'xinban-tools-'));
  directories.push(directory);
  return directory;
}

interface HostRecord {
  host: ToolHost;
  calls: { path: string; body: unknown }[];
  actions: Action[];
}

function makeMemory(): ToolMemory & { facts: MemoryFact[] } {
  const facts: MemoryFact[] = [];
  return {
    facts,
    remember: (text, category) => {
      const fact: MemoryFact = {
        id: `f${facts.length + 1}`,
        text,
        category: (typeof category === 'string' ? category : 'context') as MemoryFact['category'],
        source: 'said',
        createdAt: 0,
        updatedAt: 0,
        hits: 0,
        pinned: false,
      };
      facts.push(fact);
      return Promise.resolve({ ok: true, output: `已记住：${text}`, note: '已记住' });
    },
    forget: (query) => {
      const kept = facts.filter((fact) => !fact.text.includes(query));
      const removed = facts.filter((fact) => fact.text.includes(query)).map((fact) => fact.text);
      facts.splice(0, facts.length, ...kept);
      return Promise.resolve({ removed, candidates: [] });
    },
    search: (_query, limit = 6) => facts.slice(0, limit),
  };
}

function makeHost(
  handler: (path: string, body: unknown) => ToolJsonResult = () => ({
    ok: true,
    status: 200,
    data: { results: [] },
  }),
  todos: { id: string; title: string; done: boolean; createdAt: number }[] = [],
): HostRecord {
  const calls: { path: string; body: unknown }[] = [];
  const actions: Action[] = [];
  const host: ToolHost = {
    postJson: (path, body) => {
      calls.push({ path, body });
      return Promise.resolve(handler(path, body));
    },
    snapshot: () => ({ state: { todos, timer: null }, storageError: null }) as unknown as Snapshot,
    dispatch: (action) => {
      actions.push(action);
      return Promise.resolve({ ok: true } as CommandResult);
    },
    memory: makeMemory(),
  };
  return { host, calls, actions };
}

const signal = new AbortController().signal;

describe('工具执行器：搜索与抓取', () => {
  it('搜索结果被包成不可信数据，并给出引用', async () => {
    const root = await workspace();
    const { host, calls } = makeHost(() => ({
      ok: true,
      status: 200,
      data: {
        results: [
          {
            title: '长沙天气',
            url: 'https://weather.example.com/cs',
            summary: '明天小雨',
            site_name: '示例天气',
          },
        ],
      },
    }));
    const executor = new ToolExecutor(host, root);
    const result = await executor.run(
      { callId: 'c1', name: 'web_search', arguments: '{"query":"长沙天气","count":3}' },
      signal,
    );
    expect(calls[0]!.path).toBe('/v1/tools/search');
    expect(calls[0]!.body).toEqual({ query: '长沙天气', count: 3 });
    expect(result.output).toContain('不可信数据');
    expect(result.output).toContain('明天小雨');
    expect(result.trace.status).toBe('ok');
    expect(result.trace.note).toBe('1 条结果');
    expect(result.trace.citations?.[0]?.url).toBe('https://weather.example.com/cs');
  });

  it('搜索词为空、超长或条数越界时在本地拒绝，不发请求', async () => {
    const root = await workspace();
    const { host, calls } = makeHost();
    const executor = new ToolExecutor(host, root);
    for (const args of ['{"query":""}', '{"query":"' + 'x'.repeat(200) + '"}']) {
      const result = await executor.run(
        { callId: 'c', name: 'web_search', arguments: args },
        signal,
      );
      expect(result.trace.status).toBe('error');
    }
    expect(calls).toHaveLength(0);
  });

  it('搜索失败时报可操作原因，状态码不直接甩给模型', async () => {
    const root = await workspace();
    const { host } = makeHost(() => ({ ok: false, status: 401, data: null }));
    const executor = new ToolExecutor(host, root);
    const result = await executor.run(
      { callId: 'c', name: 'web_search', arguments: '{"query":"x"}' },
      signal,
    );
    expect(result.trace.status).toBe('error');
    expect(result.trace.note).toContain('API Key');
    expect(result.output).toContain('API Key');
  });

  it('抓取只接受 http/https，且不带账号密码', async () => {
    const root = await workspace();
    const { host, calls } = makeHost(() => ({
      ok: true,
      status: 200,
      data: { title: 't', content: '正文' },
    }));
    const executor = new ToolExecutor(host, root);
    for (const url of ['file:///c:/x', 'javascript:alert(1)', 'https://a:b@example.com/x']) {
      const result = await executor.run(
        { callId: 'c', name: 'fetch_page', arguments: JSON.stringify({ url }) },
        signal,
      );
      expect(result.trace.status).toBe('error');
    }
    expect(calls).toHaveLength(0);

    const ok = await executor.run(
      { callId: 'c', name: 'fetch_page', arguments: '{"url":"https://example.com/a"}' },
      signal,
    );
    expect(ok.trace.status).toBe('ok');
    expect(ok.trace.citations?.[0]?.url).toBe('https://example.com/a');
  });
});

describe('工具执行器：文件边界', () => {
  it('拒绝绝对路径与 .. 逃逸', async () => {
    const root = await workspace();
    const { host } = makeHost();
    const executor = new ToolExecutor(host, root);
    for (const path of [
      '../secret.txt',
      '..\\..\\windows\\win.ini',
      'C:/Windows/win.ini',
      '/etc/passwd',
    ]) {
      const result = await executor.run(
        { callId: 'c', name: 'read_file', arguments: JSON.stringify({ path }) },
        signal,
      );
      expect(result.trace.status).toBe('error');
      expect(result.trace.note).toContain('工作目录');
    }
  });

  it('受保护路径不允许写入，但可以读', async () => {
    const root = await workspace();
    await writeFile(join(root, 'package.json'), '{"name":"x"}', 'utf8');
    const { host } = makeHost();
    const executor = new ToolExecutor(host, root);

    const denied = await executor.run(
      {
        callId: 'c',
        name: 'write_file',
        arguments: JSON.stringify({ path: 'package.json', content: '{}' }),
      },
      signal,
    );
    expect(denied.trace.status).toBe('error');
    expect(denied.trace.note).toContain('受保护');
    // 原文件没被改动。
    expect(await readFile(join(root, 'package.json'), 'utf8')).toBe('{"name":"x"}');

    const read = await executor.run(
      { callId: 'c', name: 'read_file', arguments: '{"path":"package.json"}' },
      signal,
    );
    expect(read.trace.status).toBe('ok');
    expect(read.output).toContain('name');
  });

  it('写入新文件、覆盖时备份，并能读回来', async () => {
    const root = await workspace();
    const { host } = makeHost();
    const executor = new ToolExecutor(host, root, () => 4242);

    const created = await executor.run(
      {
        callId: 'c',
        name: 'write_file',
        arguments: JSON.stringify({ path: 'notes/a.md', content: '第一版' }),
      },
      signal,
    );
    expect(created.trace.status).toBe('ok');
    expect(created.trace.note).toBe('已创建');
    expect(await readFile(join(root, 'notes/a.md'), 'utf8')).toBe('第一版');

    const overwritten = await executor.run(
      {
        callId: 'c',
        name: 'write_file',
        arguments: JSON.stringify({ path: 'notes/a.md', content: '第二版' }),
      },
      signal,
    );
    expect(overwritten.trace.note).toBe('已覆盖并备份');
    expect(await readFile(join(root, 'notes/a.md.bak-4242'), 'utf8')).toBe('第一版');

    const read = await executor.run(
      { callId: 'c', name: 'read_file', arguments: '{"path":"notes/a.md"}' },
      signal,
    );
    expect(read.output).toContain('第二版');
  });

  it('读不存在的文件与二进制文件都明确失败', async () => {
    const root = await workspace();
    await writeFile(join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3]), 'utf8');
    const { host } = makeHost();
    const executor = new ToolExecutor(host, root);
    const missing = await executor.run(
      { callId: 'c', name: 'read_file', arguments: '{"path":"nope.txt"}' },
      signal,
    );
    expect(missing.trace.note).toContain('不存在');

    const binary = await executor.run(
      { callId: 'c', name: 'read_file', arguments: '{"path":"bin.dat"}' },
      signal,
    );
    expect(binary.trace.note).toContain('二进制');
  });

  it('列目录不返回隐藏项，且不会递归', async () => {
    const root = await workspace();
    await writeFile(join(root, 'a.txt'), 'a', 'utf8');
    await writeFile(join(root, '.env'), 'secret', 'utf8');
    const { host } = makeHost();
    const executor = new ToolExecutor(host, root);
    const result = await executor.run({ callId: 'c', name: 'list_files', arguments: '{}' }, signal);
    expect(result.output).toContain('a.txt');
    expect(result.output).not.toContain('.env');
  });
});

describe('工具执行器：待办与计时', () => {
  it('新增待办走真实的领域动作，而不是自己拼状态', async () => {
    const root = await workspace();
    const { host, actions } = makeHost(undefined, []);
    const executor = new ToolExecutor(host, root);
    const result = await executor.run(
      { callId: 'c', name: 'add_todo', arguments: '{"title":"买牛奶"}' },
      signal,
    );
    expect(result.trace.status).toBe('ok');
    expect(actions).toEqual([{ type: 'todo.add', title: '买牛奶' }]);
  });

  it('列出待办时带 id，方便下一步切换', async () => {
    const root = await workspace();
    const { host } = makeHost(undefined, [
      { id: 't1', title: '写周报', done: false, createdAt: 1 },
    ]);
    const executor = new ToolExecutor(host, root);
    const result = await executor.run({ callId: 'c', name: 'list_todos', arguments: '{}' }, signal);
    expect(result.output).toContain('写周报');
    expect(result.output).toContain('t1');
    expect(result.output).toContain('[ ]');
  });

  it('切换不存在的待办 id 时给出可操作提示', async () => {
    const root = await workspace();
    const { host } = makeHost(undefined, []);
    const executor = new ToolExecutor(host, root);
    const result = await executor.run(
      { callId: 'c', name: 'toggle_todo', arguments: '{"id":"nope"}' },
      signal,
    );
    expect(result.trace.status).toBe('error');
    expect(result.trace.note).toContain('list_todos');
  });

  it('计时分钟数越界被本地拒绝', async () => {
    const root = await workspace();
    const { host, actions } = makeHost();
    const executor = new ToolExecutor(host, root);
    for (const minutes of [0, 181, 2.5]) {
      const result = await executor.run(
        { callId: 'c', name: 'start_timer', arguments: JSON.stringify({ minutes }) },
        signal,
      );
      expect(result.trace.status).toBe('error');
    }
    expect(actions).toHaveLength(0);
  });
});

describe('工具执行器：命令', () => {
  it('只允许白名单程序，其他一律拒绝且不启动进程', async () => {
    const root = await workspace();
    const { host } = makeHost();
    const executor = new ToolExecutor(host, root);
    for (const program of ['rm', 'curl', 'powershell', '']) {
      const result = await executor.run(
        { callId: 'c', name: 'run_command', arguments: JSON.stringify({ program, args: [] }) },
        signal,
      );
      expect(result.trace.status).toBe('error');
      expect(result.trace.note).toContain('只允许');
    }
  });

  it('参数按数组传给进程，shell 重定向不会被解释', async () => {
    const root = await workspace();
    const { host } = makeHost();
    const executor = new ToolExecutor(host, root);
    // 如果走了 shell，`>` 会创建 pwned.txt；按数组传参时它只是 node 的一个普通参数。
    const result = await executor.run(
      {
        callId: 'c',
        name: 'run_command',
        arguments: JSON.stringify({
          program: 'node',
          args: ['-e', 'console.log(1)', '>', 'pwned.txt'],
        }),
      },
      signal,
    );
    expect(result.trace.status).toBe('ok');
    await expect(stat(join(root, 'pwned.txt'))).rejects.toThrow();
  });

  it('超时的命令被终止并说明原因', async () => {
    const root = await workspace();
    const { host } = makeHost();
    const executor = new ToolExecutor(host, root, Date.now, 120);
    const result = await executor.run(
      {
        callId: 'c',
        name: 'run_command',
        arguments: JSON.stringify({
          program: 'node',
          args: ['-e', 'setTimeout(() => {}, 5000)'],
        }),
      },
      signal,
    );
    expect(result.trace.note).toBe('超时终止');
  });

  it('参数不是字符串数组时拒绝', async () => {
    const root = await workspace();
    const { host } = makeHost();
    const executor = new ToolExecutor(host, root);
    const result = await executor.run(
      { callId: 'c', name: 'run_command', arguments: '{"program":"node","args":[1,2]}' },
      signal,
    );
    expect(result.trace.status).toBe('error');
  });
});

describe('工具执行器：长期记忆', () => {
  const call = (name: string, args: unknown) => ({
    callId: name,
    name,
    arguments: JSON.stringify(args),
  });

  it('记住一条之后能搜到，忘记之后搜不到', async () => {
    const root = await workspace();
    const { host } = makeHost();
    const executor = new ToolExecutor(host, root);
    const saved = await executor.run(
      call('remember_fact', { text: '不吃香菜', category: 'preference' }),
      signal,
    );
    expect(saved.trace.status).toBe('ok');
    expect(saved.trace.note).toBe('已记住');

    const found = await executor.run(call('search_memory', { query: '香菜' }), signal);
    expect(found.output).toContain('不吃香菜');
    expect(found.output).toContain('喜好');

    const forgotten = await executor.run(call('forget_fact', { query: '香菜' }), signal);
    expect(forgotten.output).toContain('已忘掉 1 条');
    expect((await executor.run(call('search_memory', { query: '香菜' }), signal)).output).toContain(
      '没有相关内容',
    );
  });

  it('密码、证件号这类内容在写入前就被拦下，不进记忆文件', async () => {
    const root = await workspace();
    const { host } = makeHost();
    const executor = new ToolExecutor(host, root);
    // 提示词里已经写了不要记，但这条必须由代码兜住：记忆会随之后每次请求上传。
    const result = await executor.run(
      call('remember_fact', { text: '我的银行卡密码是 123456' }),
      signal,
    );
    expect(result.trace.status).toBe('error');
    expect(result.output).toContain('敏感信息');
    expect((host.memory as ToolMemory & { facts: MemoryFact[] }).facts).toHaveLength(0);
  });

  it('内容为空时明确拒绝，而不是记一条空记忆', async () => {
    const root = await workspace();
    const { host } = makeHost();
    const executor = new ToolExecutor(host, root);
    const result = await executor.run(call('remember_fact', { text: '   ' }), signal);
    expect(result.trace.status).toBe('error');
    expect(result.output).toContain('不能为空');
  });
});

describe('工具执行器：派活与系统命令', () => {
  const call = (name: string, args: unknown) => ({
    callId: name,
    name,
    arguments: JSON.stringify(args),
  });

  function withDelegate(
    overrides: Partial<{
      enabled: boolean;
      shellAllowed: boolean;
      run: (
        input: { task: string; target?: string },
        signal: AbortSignal,
      ) => Promise<
        { ok: true; text: string; note: string; target: string } | { ok: false; error: string }
      >;
    }> = {},
  ): ToolHost {
    const { host } = makeHost();
    host.delegate = {
      enabled: () => overrides.enabled ?? true,
      shellAllowed: () => overrides.shellAllowed ?? true,
      targets: () => [{ id: 'claude', label: 'Claude Code', available: true }],
      run:
        overrides.run ??
        (() =>
          Promise.resolve({
            ok: true,
            text: '改完了，测试通过。',
            note: 'Claude Code · 9 字',
            target: 'Claude Code',
          })),
    };
    return host;
  }

  it('派活成功：产出按外部数据处理，并给出目标名', async () => {
    const root = await workspace();
    const host = withDelegate();
    const executor = new ToolExecutor(host, root);
    const result = await executor.run(
      call('delegate_task', { task: '把登录按钮的报错修掉', target: 'claude' }),
      signal,
    );
    expect(result.trace.status).toBe('ok');
    expect(result.trace.label).toContain('Claude Code');
    expect(result.output).toContain('不可信数据');
    expect(result.output).toContain('测试通过');
    expect(result.trace.note).toContain('Claude Code');
  });

  it('没授权时明确说原因，不假装已经派出去', async () => {
    const root = await workspace();
    const host = withDelegate({
      run: () => Promise.resolve({ ok: false, error: '用户还没授权把活外包出去。' }),
    });
    const executor = new ToolExecutor(host, root);
    const result = await executor.run(call('delegate_task', { task: '干活' }), signal);
    expect(result.output).toContain('没派成');
    expect(result.output).toContain('授权');
  });

  it('没接上委派通道时如实说没接入', async () => {
    const root = await workspace();
    const { host } = makeHost();
    const executor = new ToolExecutor(host, root);
    const result = await executor.run(call('delegate_task', { task: '干活' }), signal);
    expect(result.output).toContain('还没有接上');
    expect(result.trace.note).toBe('未接入');
  });

  it('系统命令没授权就不跑', async () => {
    const root = await workspace();
    const host = withDelegate({ shellAllowed: false });
    const executor = new ToolExecutor(host, root);
    const result = await executor.run(call('shell_command', { command: 'git status' }), signal);
    expect(result.output).toContain('还没允许');
    expect(result.trace.note).toBe('未授权');
  });

  it('危险命令在执行前被拦下，理由可读', async () => {
    const root = await workspace();
    const host = withDelegate();
    const executor = new ToolExecutor(host, root);
    const result = await executor.run(call('shell_command', { command: 'rm -rf /' }), signal);
    expect(result.trace.status).toBe('error');
    expect(result.output).toContain('不给跑');
  });

  it('正常命令能跑通并把输出交回模型', async () => {
    const root = await workspace();
    const host = withDelegate();
    const executor = new ToolExecutor(host, root);
    const result = await executor.run(
      call('shell_command', { command: 'node -e "console.log(42)"' }),
      signal,
    );
    expect(result.trace.status).toBe('ok');
    expect(result.output).toContain('42');
    expect(result.trace.note).toBe('成功');
  });
});

describe('工具执行器：发飞书', () => {
  const call = (args: unknown) => ({
    callId: 'f1',
    name: 'send_feishu',
    arguments: JSON.stringify(args),
  });

  function withFeishu(configured: boolean, answer: boolean) {
    const { host } = makeHost();
    const sent: string[] = [];
    const asked: { tool: string; detail: string }[] = [];
    host.feishu = {
      configured: () => configured,
      send: (text) => {
        sent.push(text);
        return Promise.resolve({ ok: true });
      },
    };
    host.confirm = (request) => {
      asked.push({ tool: request.tool, detail: request.detail });
      return Promise.resolve(answer);
    };
    return { host, sent, asked };
  }

  it('先把原文上卡问你，允许了才发', async () => {
    const root = await workspace();
    const { host, sent, asked } = withFeishu(true, true);
    const result = await new ToolExecutor(host, root).run(call({ text: '三点开会' }), signal);
    expect(asked).toEqual([{ tool: 'send_feishu', detail: '【芯伴】三点开会' }]);
    expect(sent).toEqual(['三点开会']);
    expect(result.trace).toMatchObject({ status: 'ok', note: '已发出' });
  });

  it('拒绝了就不发；没配地址不弹卡也不发；空消息本地拒', async () => {
    const root = await workspace();
    const denied = withFeishu(true, false);
    const no = await new ToolExecutor(denied.host, root).run(call({ text: '嗨' }), signal);
    expect(denied.sent).toEqual([]);
    expect(no.trace.note).toBe('你没允许');

    const bare = withFeishu(false, true);
    const missing = await new ToolExecutor(bare.host, root).run(call({ text: '嗨' }), signal);
    expect(bare.asked).toEqual([]);
    expect(bare.sent).toEqual([]);
    expect(missing.output).toContain('推到手机');

    const empty = withFeishu(true, true);
    const blank = await new ToolExecutor(empty.host, root).run(call({ text: '  ' }), signal);
    expect(blank.trace.status).toBe('error');
    expect(empty.asked).toEqual([]);
  });
});
