import { describe, expect, it } from 'vitest';
import {
  buildResponsesBody,
  historyItems,
  parseResponsesEvent,
  parseResponsesUsage,
  readOutput,
  responsesDefaults,
  responsesEndpoint,
  toolEndpoint,
} from '../src/core/responses';

describe('Responses 端点推导', () => {
  it('无论 baseUrl 带不带 /v1，都按 origin 拼 /responses', () => {
    // 文档里的 base_url 是 https://api.deepseek.com，而用户面板常填 .../v1。
    // 若直接拼成 /v1/responses 就是文档里没有的路径，所以统一取 origin。
    expect(responsesEndpoint('https://api.deepseek.com/v1')).toBe(
      'https://api.deepseek.com/responses',
    );
    expect(responsesEndpoint('https://api.deepseek.com')).toBe(
      'https://api.deepseek.com/responses',
    );
    expect(responsesEndpoint('http://127.0.0.1:9999/v1/')).toBe('http://127.0.0.1:9999/responses');
  });

  it('工具端点只允许 /v1/tools/*', () => {
    expect(toolEndpoint('https://api.deepseek.com/v1', '/v1/tools/search')).toBe(
      'https://api.deepseek.com/v1/tools/search',
    );
    expect(() => toolEndpoint('https://api.deepseek.com/v1', '/chat/completions')).toThrow();
    expect(() => toolEndpoint('https://api.deepseek.com/v1', 'https://evil.com/x')).toThrow();
  });
});

describe('Responses 请求体', () => {
  it('默认流式，带 instructions 与 input，不含 Key', () => {
    const body = JSON.parse(
      buildResponsesBody({
        model: 'deepseek-flash',
        instructions: '你是芯伴',
        input: [{ role: 'user', content: '你好' }],
      }),
    ) as { model: string; stream: boolean; instructions: string; input: unknown[] };
    expect(body.model).toBe('deepseek-flash');
    expect(body.stream).toBe(true);
    expect(body.instructions).toBe('你是芯伴');
    expect(body.input).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('sk-');
  });

  it('声明工具时才带 tools 与 tool_choice', () => {
    const withTools = JSON.parse(
      buildResponsesBody({
        model: 'm',
        instructions: 'i',
        input: [],
        tools: [{ type: 'function', name: 'f', parameters: {} }],
      }),
    ) as { tools?: unknown[]; tool_choice?: string };
    expect(withTools.tools).toHaveLength(1);
    expect(withTools.tool_choice).toBe('auto');

    const without = JSON.parse(
      buildResponsesBody({ model: 'm', instructions: 'i', input: [] }),
    ) as { tools?: unknown };
    expect(without.tools).toBeUndefined();
  });

  it('历史按 message item 传递，而不是 chat 的 messages', () => {
    expect(historyItems([{ role: 'user', content: 'a' }])).toEqual([
      { role: 'user', content: 'a' },
    ]);
  });
});

describe('Responses 流式事件', () => {
  it('取正文增量', () => {
    expect(parseResponsesEvent('{"type":"response.output_text.delta","delta":"好"}')).toEqual({
      kind: 'delta',
      text: '好',
    });
  });

  it('也认只在 event 字段里给类型的事件', () => {
    expect(parseResponsesEvent('{"event":"response.output_text.delta","delta":"x"}')).toEqual({
      kind: 'delta',
      text: 'x',
    });
  });

  it('completed 携带完整 output 与用量', () => {
    const event = parseResponsesEvent(
      JSON.stringify({
        type: 'response.completed',
        response: {
          usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35 },
          output: [{ type: 'message', content: [{ type: 'output_text', text: '答' }] }],
        },
      }),
    );
    expect(event.kind).toBe('completed');
    if (event.kind !== 'completed') throw new Error('unreachable');
    expect(event.output).toHaveLength(1);
    expect(event.usage).toEqual({ promptTokens: 30, completionTokens: 5, totalTokens: 35 });
  });

  it('failed / error 明确失败，附可读原因', () => {
    const failed = parseResponsesEvent(
      '{"type":"response.failed","response":{"error":{"code":"insufficient_quota"}}}',
    );
    expect(failed.kind).toBe('failed');
    expect(failed.kind === 'failed' && failed.error).toContain('余额');

    expect(parseResponsesEvent('{"type":"error","error":{"message":"x"}}').kind).toBe('failed');
    // 结构不认识只跳过，不当成错误，避免一个未知事件把整段回复判死。
    expect(parseResponsesEvent('{"type":"response.output_item.added"}').kind).toBe('ignore');
    expect(parseResponsesEvent('42').kind).toBe('ignore');
    expect(parseResponsesEvent('[DONE]').kind).toBe('ignore');
    // 代理插的心跳、半截垃圾：单块只标为 garbled，由上层按连续次数判定。
    expect(parseResponsesEvent('not json').kind).toBe('garbled');
    expect(parseResponsesEvent(': keep-alive').kind).toBe('garbled');
  });

  it('incomplete 也交出已有 output，便于上层判断是截断', () => {
    const event = parseResponsesEvent(
      '{"type":"response.incomplete","response":{"output":[],"usage":{"input_tokens":1,"output_tokens":0}}}',
    );
    expect(event.kind).toBe('incomplete');
  });
});

describe('Responses 输出读取', () => {
  it('拼接 message 的多个 output_text 块，并取出函数调用', () => {
    const output = readOutput([
      { type: 'reasoning', content: [] },
      { type: 'message', content: [{ type: 'output_text', text: '先说' }] },
      { type: 'message', content: [{ type: 'output_text', text: '一句' }] },
      { type: 'function_call', call_id: 'c1', name: 'web_search', arguments: '{"query":"x"}' },
    ]);
    expect(output.text).toBe('先说一句');
    expect(output.reasoning).toBe(true);
    expect(output.calls).toEqual([
      { callId: 'c1', name: 'web_search', arguments: '{"query":"x"}' },
    ]);
  });

  it('arguments 是对象时转成 JSON 字符串，缺失字段的条目跳过', () => {
    const output = readOutput([
      { type: 'function_call', call_id: 'c1', name: 'list_todos', arguments: {} },
      { type: 'function_call', name: 'no_call_id' },
      { type: 'message' },
      null,
      'junk',
    ]);
    expect(output.calls).toHaveLength(1);
    expect(output.calls[0]!.arguments).toBe('{}');
  });

  it('真实响应里的附加字段不影响解析', () => {
    const output = readOutput([
      {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '你好', annotations: [] }],
      },
    ]);
    expect(output.text).toBe('你好');
  });
});

describe('Responses 用量', () => {
  it('按 input/output 字段读取，不用 chat 的 prompt/completion', () => {
    expect(
      parseResponsesUsage({ usage: { input_tokens: 3475, output_tokens: 54, total_tokens: 3529 } }),
    ).toEqual({ promptTokens: 3475, completionTokens: 54, totalTokens: 3529 });
    expect(parseResponsesUsage({ usage: { input_tokens: 10, output_tokens: 5 } })).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it('缺失或全零时返回 null，不猜测', () => {
    expect(parseResponsesUsage(null)).toBeNull();
    expect(parseResponsesUsage({})).toBeNull();
    expect(parseResponsesUsage({ usage: {} })).toBeNull();
    expect(parseResponsesUsage({ usage: { input_tokens: 0, output_tokens: 0 } })).toBeNull();
  });

  it('默认上限足以支撑多步工具调用', () => {
    expect(responsesDefaults.maxSteps).toBeGreaterThanOrEqual(4);
    expect(responsesDefaults.maxToolCalls).toBeGreaterThanOrEqual(6);
  });
});
