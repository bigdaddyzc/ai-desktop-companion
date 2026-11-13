import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSseDecoder, describeStreamFailure } from '../src/core/ai';
import { AiService, type AgentHooks, type AiFetch, type AiFetchResponse } from '../src/desktop/ai';
import { AiCredentialStore, type AiCrypto } from '../src/desktop/ai-credentials';

const fakeKey = 'sk-test-placeholder-not-a-real-key';
const baseUrl = 'http://127.0.0.1:9999/v1';
const allowed = ['127.0.0.1'];
const encoder = new TextEncoder();

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

async function setup(fetchImpl: AiFetch, timeoutMs = 5_000) {
  const directory = await mkdtemp(join(tmpdir(), 'xinban-ai-stream-'));
  directories.push(directory);
  const store = new AiCredentialStore(join(directory, 'c.json'), crypto);
  await store.save({ baseUrl, model: 'deepseek-flash', apiKey: fakeKey });
  return { service: new AiService(store, fetchImpl, allowed, timeoutMs), store };
}

function delta(text: string): string {
  return `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`;
}

function completed(text: string, usage = { input: 40, output: 2 }): string {
  return `data: ${JSON.stringify({
    type: 'response.completed',
    response: {
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        total_tokens: usage.input + usage.output,
      },
      output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    },
  })}\n\n`;
}

/** 用给定分片模拟流式响应体；分片可以是字符串或字节，用于验证跨字节截断。 */
function streamOf(chunks: (string | Uint8Array)[]): AiFetchResponse {
  const queue = [...chunks];
  return {
    ok: true,
    status: 200,
    text: async () => '',
    body: {
      getReader: () => ({
        read: async () => {
          if (queue.length === 0) return { done: true };
          const item = queue.shift()!;
          return { done: false, value: typeof item === 'string' ? encoder.encode(item) : item };
        },
        cancel: async () => undefined,
      }),
    },
  };
}

const hooks = (): AgentHooks & { deltas: string[] } => {
  const deltas: string[] = [];
  return { deltas, onDelta: (text) => deltas.push(text), onTrace: () => undefined };
};

describe('SSE 解码器', () => {
  it('一个网络分片含多条事件时逐条产出', () => {
    const decoder = createSseDecoder();
    expect(decoder.push(delta('你') + delta('好'))).toEqual([
      '{"type":"response.output_text.delta","delta":"你"}',
      '{"type":"response.output_text.delta","delta":"好"}',
    ]);
  });

  it('事件被截断在分片中间时不提前产出', () => {
    const decoder = createSseDecoder();
    expect(decoder.push('data: {"type":"response.output_text.del')).toEqual([]);
    expect(decoder.push('ta","delta":"半"}\n')).toEqual([]);
    expect(decoder.push('\n')).toEqual(['{"type":"response.output_text.delta","delta":"半"}']);
  });

  it('兼容 CRLF 行尾', () => {
    const decoder = createSseDecoder();
    expect(decoder.push('data: {"a":1}\r\n\r\n')).toEqual(['{"a":1}']);
  });

  it('多行 data 按规范用换行拼接，注释与 event 行被忽略', () => {
    const decoder = createSseDecoder();
    expect(
      decoder.push(': keep-alive\nevent: response.created\ndata: line1\ndata: line2\n\n'),
    ).toEqual(['line1\nline2']);
  });

  it('流结束时缺少结尾空行也能取出最后一条', () => {
    const decoder = createSseDecoder();
    expect(decoder.push('data: [DONE]')).toEqual([]);
    expect(decoder.flush()).toEqual(['[DONE]']);
  });

  it('[DONE] 不以空行结尾时不残留', () => {
    const decoder = createSseDecoder();
    expect([...decoder.push('data: [DONE]\n'), ...decoder.flush()]).toEqual(['[DONE]']);
  });
});

describe('AI 服务：流式接收', () => {
  it('按增量回调，并以 response.completed 的正文为准', async () => {
    const { service } = await setup(() =>
      Promise.resolve(streamOf([delta('你'), delta('好'), delta('呀'), completed('你好呀')])),
    );
    const probe = hooks();
    const result = await service.runAgent({ text: '你好', history: [] }, probe);
    expect(probe.deltas).toEqual(['你', '好', '呀']);
    expect(result.ok && result.text).toBe('你好呀');
  });

  it('UTF-8 字符被拆到两个网络分片中间也不会乱码', async () => {
    const bytes = encoder.encode(delta('桌面'));
    const { service } = await setup(() =>
      Promise.resolve(streamOf([bytes.slice(0, 12), bytes.slice(12), completed('桌面')])),
    );
    const probe = hooks();
    const result = await service.runAgent({ text: 'hi', history: [] }, probe);
    expect(probe.deltas.join('')).toBe('桌面');
    expect(result.ok && result.text).toBe('桌面');
  });

  it('没有 response.completed 时明确报中断，不把半截文字当答复', async () => {
    const { service } = await setup(() => Promise.resolve(streamOf([delta('半截')])));
    const result = await service.runAgent({ text: 'hi', history: [] }, hooks());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('中断');
  });

  it('流内 response.failed 直接报错并停止消费', async () => {
    const { service } = await setup(() =>
      Promise.resolve(
        streamOf([
          delta('开头'),
          `data: ${JSON.stringify({
            type: 'response.failed',
            response: { error: { code: 'context_length_exceeded' } },
          })}\n\n`,
        ]),
      ),
    );
    const result = await service.runAgent({ text: 'hi', history: [] }, hooks());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('上下文');
  });

  it('单块心跳/垃圾不打断回复：跳过后照常以 completed 为准', async () => {
    const { service } = await setup(() =>
      Promise.resolve(
        streamOf([delta('你'), 'data: : keep-alive\n\n', delta('好'), completed('你好')]),
      ),
    );
    const result = await service.runAgent({ text: 'hi', history: [] }, hooks());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.text).toBe('你好');
  });

  it('连续多块无法解析的流式内容报错，而不是静默成功', async () => {
    const { service } = await setup(() =>
      Promise.resolve(streamOf(['data: not json\n\n', 'data: x\n\n', 'data: y\n\n'])),
    );
    const result = await service.runAgent({ text: 'hi', history: [] }, hooks());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('无法解析');
  });

  it('只有推理内容、没有正文时明确说明，不返回空字符串', async () => {
    const { service } = await setup(() =>
      Promise.resolve(
        streamOf([
          `data: ${JSON.stringify({ type: 'response.reasoning_text.delta', delta: '想' })}\n\n`,
          `data: ${JSON.stringify({ type: 'response.completed', response: { output: [] } })}\n\n`,
        ]),
      ),
    );
    const result = await service.runAgent({ text: 'hi', history: [] }, hooks());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('没有返回');
  });

  it('单步时限按空闲计：分片不断地来，总时长超过时限也能读完', async () => {
    const pieces = [delta('一'), delta('二'), delta('三'), delta('四'), completed('一二三四')];
    const slow: AiFetchResponse = {
      ok: true,
      status: 200,
      text: async () => '',
      body: {
        getReader: () => ({
          read: async () => {
            await new Promise((resolve) => setTimeout(resolve, 120));
            const item = pieces.shift();
            return item === undefined
              ? { done: true }
              : { done: false, value: encoder.encode(item) };
          },
          cancel: async () => undefined,
        }),
      },
    };
    const { service } = await setup(async () => slow, 300);
    const result = await service.runAgent({ text: 'hi', history: [] }, hooks());
    expect(result.ok && result.text).toBe('一二三四');
  });

  it('流卡住超过空闲时限：报「单步超时」而不是「连接中断」', async () => {
    let sent = false;
    const stalled: AiFetchResponse = {
      ok: true,
      status: 200,
      text: async () => '',
      body: {
        getReader: () => ({
          read: async () => {
            if (!sent) {
              sent = true;
              return { done: false, value: encoder.encode(delta('半句')) };
            }
            return new Promise<never>(() => undefined);
          },
          cancel: async () => undefined,
        }),
      },
    };
    const { service } = await setup(async () => stalled, 200);
    const result = await service.runAgent({ text: 'hi', history: [] }, hooks());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('单步超时');
    expect(result.error).not.toContain('连接中断');
  });

  it('中断提示明确说明内容不完整', () => {
    expect(describeStreamFailure('cancelled')).toContain('取消');
    expect(describeStreamFailure('timeout')).toContain('超时');
    expect(describeStreamFailure('network')).toContain('中断');
  });
});
