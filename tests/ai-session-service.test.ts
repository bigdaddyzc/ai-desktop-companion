import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AiSessionService } from '../src/desktop/ai-session';
import type { AgentHooks, AiService } from '../src/desktop/ai';
import type { AiSessionState } from '../src/core/ai-session';
import { MemoryService, MemoryStore } from '../src/desktop/memory';
import type { MemoryExtraction } from '../src/core/memory';

/** 只实现会话服务用到的方法；返回值可控，便于断言广播序列。 */
function fakeAi(options: {
  deltas?: string[];
  reply?: string;
  error?: string;
  citations?: { title: string; url: string; site: string }[];
  steps?: number;
  captured?: { text: string; history: unknown };
  capturedOptions?: { instructions: string; tools: readonly unknown[] };
  extraction?: MemoryExtraction | null;
  extractionInput?: { transcript: string };
}): AiService {
  return {
    async runAgent(
      input: { text: string; history: unknown },
      hooks: AgentHooks,
      runOptions?: { instructions: string; tools: readonly unknown[] },
    ) {
      if (options.captured) options.captured.history = input.history;
      if (options.captured) options.captured.text = input.text;
      if (options.capturedOptions && runOptions) Object.assign(options.capturedOptions, runOptions);
      const steps = options.steps ?? 1;
      for (let index = 0; index < steps; index += 1) {
        if (index > 0) hooks.onStepStart?.();
        for (const delta of options.deltas ?? []) hooks.onDelta(delta);
      }
      return options.error !== undefined
        ? { ok: false as const, error: options.error }
        : {
            ok: true as const,
            text: options.reply ?? input.text,
            citations: options.citations ?? [],
            traces: [],
          };
    },
    async extract(transcript: string) {
      if (options.extractionInput) options.extractionInput.transcript = transcript;
      return options.extraction ?? null;
    },
    cancel() {},
  } as unknown as AiService;
}

function collect(service: AiSessionService): AiSessionState[] {
  const seen: AiSessionState[] = [];
  service.subscribe((state) => seen.push(state));
  return seen;
}

describe('AI 会话服务', () => {
  it('增量必须真的广播出去，不能等落定时才整段出现', async () => {
    // 回归：收尾时若只清空 50ms 合并缓冲而没有 flush，界面会全程空白、最后一次性弹出。
    const service = new AiSessionService(fakeAi({ deltas: ['你', '好'], reply: '你好' }));
    const seen = collect(service);
    await service.send('问');
    expect(seen.some((state) => state.streaming === '你好')).toBe(true);
  });

  it('成功时先上屏提问，再把回复落成一轮', async () => {
    const service = new AiSessionService(fakeAi({ deltas: ['你', '好'], reply: '你好' }));
    const seen = collect(service);
    const result = await service.send('  打个招呼  ');

    expect(result.ok).toBe(true);
    expect(seen[0]!.turns).toEqual([{ role: 'user', content: '打个招呼' }]);
    expect(seen[0]!.busy).toBe(true);
    expect(service.snapshot().turns).toEqual([
      { role: 'user', content: '打个招呼' },
      { role: 'assistant', content: '你好' },
    ]);
    expect(service.snapshot().busy).toBe(false);
    expect(service.snapshot().streaming).toBe('');
  });

  it('把上一次提问与回答作为历史发给模型，且不含本次提问', async () => {
    const captured: { text: string; history: unknown } = { text: '', history: null };
    const service = new AiSessionService(fakeAi({ deltas: ['答'], reply: '答', captured }));
    await service.send('第一问');
    await service.send('第二问');
    expect(captured.text).toBe('第二问');
    expect(captured.history).toEqual([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '答' },
    ]);
  });

  it('失败时丢掉半截内容并记录原因，下一轮会清掉错误', async () => {
    const service = new AiSessionService(fakeAi({ deltas: ['半截'], error: '连接中断' }));
    const result = await service.send('问一句');
    expect(result.ok).toBe(false);
    expect(service.snapshot().turns).toEqual([{ role: 'user', content: '问一句' }]);
    expect(service.snapshot().streaming).toBe('');
    expect(service.snapshot().error).toBe('连接中断');
  });

  it('空消息与超长消息在进入网络前就被拒绝', async () => {
    const service = new AiSessionService(fakeAi({ reply: '不该被调用' }));
    expect((await service.send('   ')).ok).toBe(false);
    expect((await service.send('x'.repeat(2_001))).ok).toBe(false);
    expect(service.snapshot().turns).toEqual([]);
  });

  it('一次只允许一个请求，并发调用被拒绝而不是排队扣费', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new AiSessionService({
      async runAgent() {
        await gate;
        return { ok: true as const, text: '好', citations: [], traces: [] };
      },
      cancel() {},
    } as unknown as AiService);

    const first = service.send('第一条');
    // 等第一个请求真正进入忙碌态，再发第二条。
    await Promise.resolve();
    const second = await service.send('第二条');
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error).toContain('回复中');
    release?.();
    expect((await first).ok).toBe(true);
    expect(service.snapshot().turns.filter((turn) => turn.role === 'user')).toHaveLength(1);
  });

  it('取消后订阅者仍能收到最终状态，不会卡在「正在回复」', async () => {
    const service = new AiSessionService(fakeAi({ error: '已取消本次请求，半截回复已丢弃。' }));
    const seen = collect(service);
    await service.send('问');
    service.cancel();
    const last = seen[seen.length - 1]!;
    expect(last.busy).toBe(false);
    expect(last.error).toContain('已取消');
  });

  it('多步运行时每步清空气泡，不会把中间话术和结论拼在一起', async () => {
    const service = new AiSessionService(fakeAi({ deltas: ['先查一下'], reply: '结论', steps: 2 }));
    const seen = collect(service);
    await service.send('问');
    // 每步开始都会推一次空的 streaming；落定后只有最终结论留在 turns 里。
    expect(seen.some((state) => state.streaming === '')).toBe(true);
    expect(service.snapshot().turns[1]).toEqual({ role: 'assistant', content: '结论' });
    expect(JSON.stringify(service.snapshot().turns)).not.toContain('先查一下');
  });

  it('来源链接随回复一起保存，供界面核对', async () => {
    const service = new AiSessionService(
      fakeAi({
        reply: '长沙明天小雨。',
        citations: [{ title: '长沙天气', url: 'https://example.com/a', site: 'example.com' }],
      }),
    );
    await service.send('长沙明天天气');
    expect(service.snapshot().citations).toHaveLength(1);
    expect(service.snapshot().citations[0]!.url).toBe('https://example.com/a');
  });

  it('多次搜索返回同一链接时只保留一条，面板不被刷屏', async () => {
    const service = new AiSessionService(
      fakeAi({
        reply: '答',
        citations: [
          { title: 'A', url: 'https://a.com/x', site: 'a' },
          { title: 'A again', url: 'https://a.com/x', site: 'a' },
          { title: 'B', url: 'https://b.com/y', site: 'b' },
        ],
      }),
    );
    await service.send('问');
    expect(service.snapshot().citations).toHaveLength(2);
  });

  it('失败时不保留上一轮的来源，避免把旧证据挂到新问题上', async () => {
    const service = new AiSessionService(fakeAi({ deltas: ['半截'], error: '连接中断' }));
    await service.send('问');
    expect(service.snapshot().citations).toEqual([]);
  });
});

describe('AI 会话服务：记忆接线', () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  async function makeMemory(): Promise<MemoryService> {
    const directory = await mkdtemp(join(tmpdir(), 'xinban-session-memory-'));
    directories.push(directory);
    const memory = new MemoryService(new MemoryStore(join(directory, 'memory-v1.json')));
    await memory.init();
    return memory;
  }

  /** learn() 是 fire-and-forget，等它跑完再断言。 */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('已经记住的事会随提问注入 instructions', async () => {
    const memory = await makeMemory();
    await memory.remember('不吃香菜', 'preference');
    const capturedOptions = { instructions: '', tools: [] as readonly unknown[] };
    const service = new AiSessionService(fakeAi({ reply: '好', capturedOptions }), memory);

    await service.send('晚上吃什么好');
    expect(capturedOptions.instructions).toContain('不吃香菜');
    expect(capturedOptions.instructions).toContain('216×216');
    // 记忆类工具默认在工具表里，模型能自己「记住」新东西。
    expect((capturedOptions.tools as { name: string }[]).map((tool) => tool.name)).toContain(
      'remember_fact',
    );
  });

  it('回复之后自动整理记忆，下次提问就能用上', async () => {
    const memory = await makeMemory();
    const service = new AiSessionService(
      fakeAi({
        reply: '记下了。',
        extraction: {
          facts: [{ text: '在长沙做医院信息化工作', category: 'identity' }],
          episode: '聊了工作',
        },
      }),
      memory,
    );
    await service.send('我在长沙做医院信息化');
    await settle();

    expect(memory.snapshot().facts.map((fact) => fact.text)).toContain('在长沙做医院信息化工作');
    expect(memory.snapshot().episodes[0]?.summary).toBe('聊了工作');
    expect(memory.promptFor('我在哪工作')).toContain('在长沙做医院信息化工作');
  });

  it('抽取的输入包含本轮问答，而不是只有半截', async () => {
    const memory = await makeMemory();
    const extractionInput = { transcript: '' };
    const service = new AiSessionService(
      fakeAi({ reply: '好的。', extractionInput, extraction: { facts: [], episode: '' } }),
      memory,
    );
    await service.send('帮我记一下周五交材料');
    await settle();
    expect(extractionInput.transcript).toContain('用户：帮我记一下周五交材料');
    expect(extractionInput.transcript).toContain('芯伴：好的。');
  });

  it('记忆关闭时不注入、不抽取，也不提供记忆工具', async () => {
    const memory = await makeMemory();
    await memory.remember('不吃香菜', 'preference');
    await memory.setEnabled(false);
    const capturedOptions = { instructions: '', tools: [] as readonly unknown[] };
    const extractionInput = { transcript: '不该被调用' };
    const service = new AiSessionService(
      fakeAi({ reply: '好', capturedOptions, extractionInput }),
      memory,
    );

    await service.send('晚上吃什么');
    await settle();
    expect(capturedOptions.instructions).not.toContain('不吃香菜');
    expect((capturedOptions.tools as { name: string }[]).map((tool) => tool.name)).not.toContain(
      'remember_fact',
    );
    // 没有被调用过：transcript 仍是初始值。
    expect(extractionInput.transcript).toBe('不该被调用');
  });

  it('抽取失败不影响已经完成的回复', async () => {
    const memory = await makeMemory();
    const service = new AiSessionService(
      fakeAi({
        reply: '答完了。',
        // 模拟抽取链路抛错：会话服务内部必须自己兜住。
        extraction: null,
      }),
      memory,
    );
    const result = await service.send('随便问问');
    await settle();
    expect(result.ok).toBe(true);
    expect(service.snapshot().turns[1]).toEqual({ role: 'assistant', content: '答完了。' });
    expect(memory.snapshot().facts).toHaveLength(0);
  });

  it('抽取还在路上时清空记忆：结果回来也不再写回去', async () => {
    const memory = await makeMemory();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ai = fakeAi({ reply: '好' });
    (ai as unknown as { extract: () => Promise<MemoryExtraction> }).extract = async () => {
      await gate;
      return {
        facts: [{ text: '在长沙做医院信息化工作', category: 'identity' }],
        episode: '聊了工作',
      };
    };
    const service = new AiSessionService(ai, memory);
    await service.send('我在长沙做医院信息化');
    await memory.clear();
    release();
    await settle();
    await memory.settled();
    expect(memory.snapshot().facts).toHaveLength(0);
    expect(memory.snapshot().episodes).toHaveLength(0);
  });

  it('清空记忆后的下一轮：抽取不再带上清空前的对话', async () => {
    const memory = await makeMemory();
    const extractionInput = { transcript: '' };
    const service = new AiSessionService(
      fakeAi({ reply: '收到。', extractionInput, extraction: { facts: [], episode: '' } }),
      memory,
    );
    await service.send('我家住在岳麓区');
    await settle();
    expect(extractionInput.transcript).toContain('岳麓区');
    await memory.clear();
    await service.send('今天天气怎么样');
    await settle();
    expect(extractionInput.transcript).toContain('今天天气怎么样');
    expect(extractionInput.transcript).not.toContain('岳麓区');
  });

  it('没有记忆服务时照常工作，不因为缺少依赖而崩', async () => {
    const service = new AiSessionService(fakeAi({ reply: '好' }));
    expect((await service.send('问')).ok).toBe(true);
    expect(service.snapshot().turns).toHaveLength(2);
  });
});
