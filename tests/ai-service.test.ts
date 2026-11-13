import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AiService, type AgentHooks, type AiFetch, type AiFetchResponse } from '../src/desktop/ai';
import { AiCredentialStore, type AiCrypto } from '../src/desktop/ai-credentials';
import type { ToolExecution } from '../src/desktop/tools';
import { toolsFor } from '../src/core/agent';

const fakeKey = 'sk-test-placeholder-not-a-real-key';
const baseUrl = 'http://127.0.0.1:9999/v1';
const allowed = ['127.0.0.1'];

const crypto: AiCrypto = {
  available: () => true,
  encrypt: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
  decrypt: (payload) => payload.toString('utf8').slice(4),
};

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

/** 把事件数组拼成 SSE 文本；不带 body，走「整段文本」分支，顺带覆盖解码器。 */
function sse(events: unknown[]): AiFetchResponse {
  return {
    ok: true,
    status: 200,
    text: async () => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
  };
}

function completed(output: unknown[], usage?: { input: number; output: number }): unknown {
  return {
    type: 'response.completed',
    response: {
      usage: usage
        ? {
            input_tokens: usage.input,
            output_tokens: usage.output,
            total_tokens: usage.input + usage.output,
          }
        : undefined,
      output,
    },
  };
}

function answer(text: string, usage = { input: 40, output: 2 }): AiFetchResponse {
  return sse([
    { type: 'response.output_text.delta', delta: text },
    completed([{ type: 'message', content: [{ type: 'output_text', text }] }], usage),
  ]);
}

function call(callId: string, name: string, args: string): unknown {
  return {
    type: 'response.completed',
    response: {
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
      output: [{ type: 'function_call', call_id: callId, name, arguments: args }],
    },
  };
}

function failure(status: number): AiFetchResponse {
  return { ok: false, status, text: async () => '{"error":"server detail"}' };
}

const hooks = (): AgentHooks & { deltas: string[] } => {
  const deltas: string[] = [];
  return { deltas, onDelta: (text) => deltas.push(text), onTrace: () => undefined };
};

function fakeTools(seen: string[]): {
  run: (call: { callId: string; name: string; arguments: string }) => Promise<ToolExecution>;
} {
  return {
    run: (invoked) => {
      seen.push(`${invoked.name}:${invoked.arguments}`);
      return Promise.resolve({
        output: '工具结果',
        trace: {
          callId: invoked.callId,
          name: invoked.name,
          label: '搜索',
          status: 'ok',
          note: '1 条',
          citations: [{ title: '示例', url: 'https://example.com/a', site: 'example.com' }],
        },
      });
    },
  };
}

async function setup(fetchImpl: AiFetch, timeoutMs = 500) {
  const directory = await mkdtemp(join(tmpdir(), 'xinban-ai-service-'));
  directories.push(directory);
  const store = new AiCredentialStore(join(directory, 'c.json'), crypto);
  await store.save({ baseUrl, model: 'deepseek-flash', apiKey: fakeKey });
  return { service: new AiService(store, fetchImpl, allowed, timeoutMs), store };
}

describe('AI 服务：未配置与非白名单端点', () => {
  it('未配置 Key 时明确拒绝，且不发起任何网络请求', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xinban-ai-empty-'));
    directories.push(directory);
    let calls = 0;
    const service = new AiService(
      new AiCredentialStore(join(directory, 'c.json'), crypto),
      () => {
        calls += 1;
        return Promise.resolve(answer('unexpected'));
      },
      allowed,
    );
    const result = await service.runAgent({ text: '你好', history: [] }, hooks());
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('尚未配置');
    expect(calls).toBe(0);
    expect(await service.status()).toMatchObject({ configured: false });
  });

  it('拒绝非白名单端点，且不保存 Key', async () => {
    const { service, store } = await setup(() => Promise.resolve(answer('ok')));
    const result = await service.configure({
      baseUrl: 'https://evil.example.com/v1',
      model: 'deepseek-flash',
      apiKey: fakeKey,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('只允许');
    expect((await store.load())?.baseUrl).toBe(baseUrl);
  });

  it('status 不返回 Key，并暴露工具调用计数', async () => {
    const { service } = await setup(() => Promise.resolve(answer('ok')));
    const status = await service.status();
    expect(status).toMatchObject({
      configured: true,
      model: 'deepseek-flash',
      busy: false,
      toolCalls: 0,
    });
    expect(JSON.stringify(status)).not.toContain('sk-');
  });
});

describe('AI 服务：请求与错误', () => {
  it('成功时返回模型文本，请求打到 /responses 且不含本地业务数据', async () => {
    let url = '';
    let body = '';
    const { service } = await setup((target, init) => {
      url = target;
      body = init.body;
      return Promise.resolve(answer('你好呀'));
    });
    const result = await service.runAgent({ text: '你好', history: [] }, hooks());
    expect(result.ok && result.text).toBe('你好呀');
    // baseUrl 带 /v1，但 Responses 端点必须按 origin 推导，不能出现 /v1/responses。
    expect(url).toBe('http://127.0.0.1:9999/responses');
    // 出站内容只有用户主动输入的一句与工具声明，没有待办、计时等本地数据。
    const parsed = JSON.parse(body) as { input: unknown[]; tools?: unknown[] };
    expect(parsed.input).toEqual([{ role: 'user', content: '你好' }]);
    // 没有注入执行器时不声明工具：模型不该被引导去调用根本跑不了的东西。
    expect(parsed.tools).toBeUndefined();
    expect(body).not.toContain(fakeKey);
    expect(body).toContain('deepseek-flash');
  });

  it('HTTP 401/402/429 只给可操作提示，错误里不含 Key 或响应体', async () => {
    for (const status of [401, 402, 429]) {
      const { service } = await setup(() => Promise.resolve(failure(status)));
      const result = await service.runAgent({ text: 'hi', history: [] }, hooks());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error).not.toContain('sk-');
      expect(result.error).not.toContain('server detail');
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it('只在成功请求上累计 token 用量，失败不计数', async () => {
    let fail = false;
    const { service } = await setup(() =>
      Promise.resolve(fail ? failure(500) : answer('ok', { input: 40, output: 2 })),
    );
    expect((await service.status()).usage).toEqual({
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
    await service.runAgent({ text: 'a', history: [] }, hooks());
    await service.runAgent({ text: 'b', history: [] }, hooks());
    fail = true;
    await service.runAgent({ text: 'c', history: [] }, hooks());
    expect((await service.status()).usage).toEqual({
      requests: 2,
      promptTokens: 80,
      completionTokens: 4,
      totalTokens: 84,
    });
  });

  it('请求失败不自动重试（避免重复扣费）', async () => {
    let calls = 0;
    const { service } = await setup(() => {
      calls += 1;
      return Promise.resolve(failure(500));
    });
    const result = await service.runAgent({ text: 'hi', history: [] }, hooks());
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('网络异常统一脱敏', async () => {
    const { service } = await setup(() =>
      Promise.reject(new Error(`POST ${baseUrl} Bearer ${fakeKey}`)),
    );
    const result = await service.runAgent({ text: 'hi', history: [] }, hooks());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).not.toContain('sk-');
    expect(result.error).not.toContain('Bearer');
    expect(result.error).toContain('无法连接');
  });
});

describe('AI 服务：工具循环', () => {
  it('先执行模型要求的工具，再把结果回填并继续，直到拿到最终答复', async () => {
    const seen: string[] = [];
    const bodies: string[] = [];
    let round = 0;
    const { service } = await setup((_url, init) => {
      bodies.push(init.body);
      round += 1;
      return Promise.resolve(
        round === 1
          ? sse([call('c1', 'web_search', '{"query":"长沙天气"}')])
          : answer('明天小雨。'),
      );
    });
    service.setTools(fakeTools(seen));
    const traces: string[] = [];
    const result = await service.runAgent(
      { text: '长沙明天天气', history: [] },
      {
        onDelta: () => undefined,
        onTrace: (list) => traces.push(list.map((item) => `${item.name}:${item.status}`).join(',')),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.text).toBe('明天小雨。');
    expect(seen).toEqual(['web_search:{"query":"长沙天气"}']);
    // 第一轮就应声明全部工具，否则模型根本不知道能搜。
    const first = JSON.parse(bodies[0]!) as { tools?: unknown[]; tool_choice?: string };
    // 20 个通用工具（含 play_audio / music / look / delegate_task / shell_command / edit_file / send_feishu）+ 3 个记忆工具。
    // 少一个都会让模型「不会用」某个能力。
    expect(first.tools).toHaveLength(23);
    expect(first.tool_choice).toBe('auto');
    // 第二轮请求必须带上 function_call_output，否则模型不知道工具跑出了什么。
    const second = JSON.parse(bodies[1]!) as { input: { type?: string; call_id?: string }[] };
    expect(second.input.some((item) => item.type === 'function_call_output')).toBe(true);
    expect(second.input.some((item) => item.call_id === 'c1')).toBe(true);
    // 轨迹先 running 再 ok，界面才有「搜索中 → 1 条」的变化。
    expect(traces[0]).toBe('web_search:running');
    expect(traces[traces.length - 1]).toBe('web_search:ok');
    expect(result.ok && result.citations).toHaveLength(1);
  });

  it('长工具执行期间整轮预算暂停：派活几分钟也不该被 150 秒总表掐掉', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xinban-ai-budget-'));
    directories.push(directory);
    const store = new AiCredentialStore(join(directory, 'c.json'), crypto);
    await store.save({ baseUrl, model: 'deepseek-flash', apiKey: fakeKey });
    let round = 0;
    const service = new AiService(
      store,
      () => {
        round += 1;
        return Promise.resolve(
          round === 1
            ? sse([call('c1', 'delegate_task', '{"task":"修 bug"}')])
            : answer('修好了。'),
        );
      },
      allowed,
      500,
      // 把 150 秒预算压到 200ms，工具跑 600ms：不暂停就会 abort。
      // 曾经是 40ms/120ms，全量并行跑时光走到工具那一步就可能超 40ms，误报失败。
      200,
    );
    let abortedDuringTool = false;
    service.setTools({
      run: async (_call, signal): Promise<ToolExecution> => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        // 真派活就靠这个信号 kill 子进程。它要是被总表 abort 了，活就死在半路。
        abortedDuringTool = signal.aborted;
        return {
          output: '工具结果',
          trace: {
            callId: 'c1',
            name: 'delegate_task',
            label: '派活',
            status: 'ok',
            note: '完成',
          },
        };
      },
    });
    const result = await service.runAgent({ text: '修 bug', history: [] }, hooks());
    expect(abortedDuringTool).toBe(false);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe('修好了。');
  });

  it('同一批工具被原样重复调用时停止，不空转烧钱', async () => {
    let calls = 0;
    const { service } = await setup(() => {
      calls += 1;
      return Promise.resolve(sse([call('c1', 'web_search', '{"query":"同样的查询"}')]));
    });
    service.setTools(fakeTools([]));
    const result = await service.runAgent({ text: '查', history: [] }, hooks());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('重复');
    expect(calls).toBe(2);
  });

  it('步数用尽后不带工具再要一次结论，而不是直接失败', async () => {
    const bodies: { tools?: unknown[] }[] = [];
    let round = 0;
    const { service } = await setup((_url, init) => {
      bodies.push(JSON.parse(init.body) as { tools?: unknown[] });
      round += 1;
      if (round <= 8)
        return Promise.resolve(sse([call(`c${round}`, 'web_search', `{"query":"q${round}"}`)]));
      return Promise.resolve(answer('根据已有信息，先这样。'));
    });
    service.setTools(fakeTools([]));
    const result = await service.runAgent({ text: '做点什么', history: [] }, hooks());
    expect(result.ok && result.text).toBe('根据已有信息，先这样。');
    // 收尾那次请求不应再声明工具。
    expect(bodies[bodies.length - 1]!.tools).toBeUndefined();
  });

  it('工具未初始化时明确报错，而不是假装没有工具可调', async () => {
    const { service } = await setup(() => Promise.resolve(sse([call('c1', 'web_search', '{}')])));
    const result = await service.runAgent({ text: '查', history: [] }, hooks());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('工具未初始化');
  });
});

describe('AI 服务：超时、取消与并发', () => {
  it('超时后停止等待并给出明确提示', async () => {
    const { service } = await setup(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      10,
    );
    const result = await service.runAgent({ text: 'hi', history: [] }, hooks());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('超时');
    expect(await service.status()).toMatchObject({ busy: false });
  });

  it('用户取消后返回已取消，不把取消伪装成成功', async () => {
    const holder: { service?: AiService } = {};
    const fetchImpl: AiFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        queueMicrotask(() => holder.service?.cancel());
      });
    const { service } = await setup(fetchImpl, 5_000);
    holder.service = service;
    const result = await service.runAgent({ text: 'hi', history: [] }, hooks());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('取消');
    expect(await service.status()).toMatchObject({ busy: false });
  });

  it('一次只允许一个请求，第二个被拒且不会重复发起', async () => {
    let calls = 0;
    const fetchImpl: AiFetch = () =>
      new Promise((resolve) => {
        calls += 1;
        setTimeout(() => resolve(answer('ok')), 60);
      });
    const { service } = await setup(fetchImpl, 5_000);
    const first = service.runAgent({ text: 'hi', history: [] }, hooks());
    // 别用固定 sleep：CPU 繁忙时 15ms 里 store.load() 都未必走完，
    // calls 还是 0，测试就把「启动慢」误报成并发闸门坏了。
    await expect.poll(() => calls, { timeout: 2_000 }).toBe(1);
    const second = await service.runAgent({ text: 'again', history: [] }, hooks());
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.error).toContain('已有请求');
    expect(calls).toBe(1);
    expect((await first).ok).toBe(true);
    expect(await service.status()).toMatchObject({ busy: false });
  });
});

describe('AI 服务：工具借用鉴权', () => {
  it('postJson 只允许 /v1/tools/*，其他路径直接拒绝且不发请求', async () => {
    let calls = 0;
    const { service } = await setup(() => {
      calls += 1;
      return Promise.resolve(sse([]));
    });
    const result = await service.postJson('/v1/chat/completions', {}, new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(calls).toBe(0);
  });

  it('postJson 走工具端点并返回 JSON，错误状态如实上报', async () => {
    const urls: string[] = [];
    const { service } = await setup((url) => {
      urls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ results: [] }),
      });
    });
    const ok = await service.postJson(
      '/v1/tools/search',
      { query: 'x' },
      new AbortController().signal,
    );
    expect(ok).toEqual({ ok: true, status: 200, data: { results: [] } });
    expect(urls[0]).toBe('http://127.0.0.1:9999/v1/tools/search');
  });
});

describe('AI 服务：人格与记忆', () => {
  it('记忆关闭时请求里不带记忆工具，其余工具照常', async () => {
    const bodies: { tools?: { name: string }[] }[] = [];
    const { service } = await setup((_url, init) => {
      bodies.push(JSON.parse(init.body) as { tools?: { name: string }[] });
      return Promise.resolve(answer('好'));
    });
    service.setTools(fakeTools([]));
    await service.runAgent({ text: 'hi', history: [] }, hooks(), {
      instructions: '只有这句指令',
      tools: toolsFor(false),
    });
    const tools = bodies[0]!.tools ?? [];
    // 20 个通用工具（含 music、edit_file、send_feishu），不含 3 个记忆工具。
    expect(tools).toHaveLength(20);
    expect(tools.some((tool) => tool.name === 'remember_fact')).toBe(false);
    expect(tools.some((tool) => tool.name === 'web_search')).toBe(true);
    expect(tools.some((tool) => tool.name === 'work_status')).toBe(true);
    // 感官工具也必须在：问「你能听见我吗」时模型要有得可调。
    expect(tools.some((tool) => tool.name === 'senses')).toBe(true);
    // 看画面的工具同理：少了它，模型只能回答「我看不到」。
    expect(tools.some((tool) => tool.name === 'look')).toBe(true);
    // 派活与命令也必须在：少了它们，模型只会说「我做不到」。
    expect(tools.some((tool) => tool.name === 'delegate_task')).toBe(true);
    expect(tools.some((tool) => tool.name === 'shell_command')).toBe(true);
  });

  it('调用方给的 instructions 原样进请求，不再用写死的系统提示词', async () => {
    const bodies: { instructions?: string }[] = [];
    const { service } = await setup((_url, init) => {
      bodies.push(JSON.parse(init.body) as { instructions?: string });
      return Promise.resolve(answer('好'));
    });
    await service.runAgent({ text: 'hi', history: [] }, hooks(), {
      instructions: '记得他叫老王',
      tools: [],
    });
    expect(bodies[0]!.instructions).toBe('记得他叫老王');
  });

  it('后台抽取不开工具、不占 busy，并解析出事实与纪要', async () => {
    const bodies: { tools?: unknown[]; max_output_tokens?: number }[] = [];
    const { service } = await setup((_url, init) => {
      bodies.push(JSON.parse(init.body) as { tools?: unknown[]; max_output_tokens?: number });
      return Promise.resolve(
        sse([
          completed(
            [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: '```json\n{"facts":[{"text":"不吃香菜","category":"preference"}],"episode":"聊了晚饭"}\n```',
                  },
                ],
              },
            ],
            { input: 120, output: 20 },
          ),
        ]),
      );
    });
    const result = await service.extract('用户：我不吃香菜\n芯伴：记下了。');
    expect(result?.facts[0]).toEqual({ text: '不吃香菜', category: 'preference' });
    expect(result?.episode).toBe('聊了晚饭');
    expect(bodies[0]!.tools).toBeUndefined();
    expect(bodies[0]!.max_output_tokens).toBe(400);
    // 抽取也计费，用量必须算进这次运行的统计里，不能悄悄少报。
    expect((await service.status()).usage.requests).toBe(1);
    // 抽取结束后不应把服务卡在 busy 上。
    expect((await service.status()).busy).toBe(false);
  });

  it('抽取失败时静默返回 null，不抛错也不影响后续对话', async () => {
    const { service } = await setup(() => Promise.resolve(failure(500)));
    expect(await service.extract('用户：随便说说')).toBeNull();
  });

  it('抽取时把已经记得的几条附在记录后面', async () => {
    const bodies: { input: { content: unknown }[] }[] = [];
    const { service } = await setup((_url, init) => {
      bodies.push(JSON.parse(init.body) as { input: { content: unknown }[] });
      return Promise.resolve(answer('{"facts":[],"episode":""}'));
    });
    await service.extract('用户：又熬到三点', ['常年熬夜']);
    expect(JSON.stringify(bodies[0]!.input)).toContain('已经记得：\\n- 常年熬夜');
  });
});

describe('工具标记漏进正文', () => {
  const leaked = [
    '我让 Claude 去重写。',
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ invoke name="web_search">',
    '<｜｜DSML｜｜ parameter name="query" string="true">长沙天气</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>',
    '</｜｜DSML｜｜ calls>',
  ].join('\n');
  const tools = toolsFor(true);

  it('读得懂就照常执行，屏幕上看不到标记，回传的是正规 function_call', async () => {
    const bodies: { input: { type?: string; call_id?: string; name?: string }[] }[] = [];
    const replies = [answer(leaked), answer('广州晴。')];
    const { service } = await setup((_url, init) => {
      bodies.push(JSON.parse(init.body) as (typeof bodies)[number]);
      return Promise.resolve(replies.shift()!);
    });
    const seen: string[] = [];
    service.setTools(fakeTools(seen));
    const watch = hooks();
    const result = await service.runAgent({ text: '长沙天气', history: [] }, watch, {
      instructions: '',
      tools,
    });
    expect(result.ok && result.text).toBe('广州晴。');
    expect(seen).toEqual(['web_search:{"query":"长沙天气"}']);
    expect(watch.deltas.join('')).not.toContain('DSML');
    expect(watch.deltas.join('')).toContain('我让 Claude 去重写。');
    const second = bodies[1]!.input;
    const call = second.find((item) => item.type === 'function_call');
    const output = second.find((item) => item.type === 'function_call_output');
    expect(call?.name).toBe('web_search');
    expect(output?.call_id).toBe(call?.call_id);
    expect(JSON.stringify(second)).not.toContain('DSML');
  });

  it('写得不完整就不执行，只留标记前那句话', async () => {
    const cut = leaked.slice(0, leaked.indexOf('天气</'));
    const { service } = await setup(() => Promise.resolve(answer(cut)));
    const seen: string[] = [];
    service.setTools(fakeTools(seen));
    const result = await service.runAgent({ text: '长沙天气', history: [] }, hooks(), {
      instructions: '',
      tools,
    });
    expect(result.ok && result.text).toBe('我让 Claude 去重写。');
    expect(seen).toEqual([]);
  });

  it('整段只有写坏的标记时，用人话告诉用户没执行', async () => {
    const only = leaked.slice(leaked.indexOf('<'), leaked.indexOf('天气</'));
    const { service } = await setup(() => Promise.resolve(answer(only)));
    service.setTools(fakeTools([]));
    const result = await service.runAgent({ text: '长沙天气', history: [] }, hooks(), {
      instructions: '',
      tools,
    });
    expect(result).toEqual({
      ok: false,
      error: '它想调用工具，但指令写坏了，这次没有执行。再说一遍试试。',
    });
  });
});

describe('记忆整理请求', () => {
  it('不开工具、用整理提示词、给足输出长度，并计入用量', async () => {
    const bodies: { tools?: unknown[]; instructions: string; max_output_tokens: number }[] = [];
    const { service } = await setup((_url, init) => {
      bodies.push(JSON.parse(init.body) as (typeof bodies)[number]);
      return Promise.resolve(answer('{"actions":[]}'));
    });
    const result = await service.tidy('#1 [习惯] 常年熬夜');
    expect(result).toEqual({ ok: true, text: '{"actions":[]}' });
    expect(bodies[0]!.tools).toBeUndefined();
    expect(bodies[0]!.instructions).toContain('整理自己对一个人的长期记忆');
    expect(bodies[0]!.max_output_tokens).toBe(20_000);
    expect((await service.status()).usage.requests).toBe(1);
    expect((await service.status()).busy).toBe(false);
  });

  it('思考吃光额度、正文为空时明确说出来，而不是「没看懂」', async () => {
    const { service } = await setup(() =>
      Promise.resolve(
        sse([
          { type: 'response.reasoning_text.delta', delta: '我想想…' },
          {
            type: 'response.incomplete',
            response: { output: [{ type: 'reasoning', content: [] }] },
          },
        ]),
      ),
    );
    const result = await service.tidy('#1 [习惯] 常年熬夜');
    expect(result).toEqual({
      ok: false,
      error: '模型想太久，没来得及写出方案，记忆没动。可以再试一次。',
    });
  });

  it('失败时给出可读原因，不抛错', async () => {
    const { service } = await setup(() => Promise.resolve(failure(401)));
    const result = await service.tidy('#1 [习惯] 常年熬夜');
    expect(result.ok).toBe(false);
  });
});
