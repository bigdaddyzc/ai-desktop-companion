import { describe, expect, it } from 'vitest';
import {
  buildSession,
  callLabel,
  clipText,
  describeSession,
  emptyProgress,
  parseSessionHead,
  parseSessionTail,
  progressPrompt,
  progressToolText,
  statusOf,
  stripInjectedBlocks,
  userTextOf,
  verbFor,
  type WorkSession,
} from '../src/core/progress';

const now = 1_800_000_000_000;
function line(value: unknown): string {
  return JSON.stringify(value);
}

const userMessage = (text: string, at: number): string =>
  line({
    type: 'message',
    role: 'user',
    timestamp: at,
    sessionId: 's-1',
    cwd: 'D:/work/demo',
    content: [{ type: 'input_text', text }],
  });

const assistantMessage = (text: string, at: number): string =>
  line({
    type: 'message',
    role: 'assistant',
    timestamp: at,
    sessionId: 's-1',
    cwd: 'D:/work/demo',
    content: [{ type: 'output_text', text }],
  });

const call = (name: string, args: string, at: number, callId = 'c1'): string =>
  line({ type: 'function_call', name, callId, arguments: args, timestamp: at, sessionId: 's-1' });

const result = (at: number, callId = 'c1'): string =>
  line({ type: 'function_call_result', callId, status: 'completed', timestamp: at });

describe('stripInjectedBlocks', () => {
  it('优先取 <user_query> 里的原话，不把它当注入块删掉', () => {
    const raw = [
      '<system-reminder data-role="user-context">',
      '<user_info>OS Version: win32</user_info>',
      '</system-reminder>',
      '<user_query>芯伴怎么知道我干到哪了</user_query>',
    ].join('\n');
    expect(userTextOf(raw)).toBe('芯伴怎么知道我干到哪了');
  });

  it('去掉宿主注入的环境块，只留下用户真正说的话', () => {
    const raw = [
      '<system-reminder data-role="user-context">',
      '<user_info>\nOS Version: win32\n</user_info>',
      '</system-reminder>',
      '帮我看下构建为什么挂了',
    ].join('\n');
    expect(stripInjectedBlocks(raw)).toBe('帮我看下构建为什么挂了');
  });

  it('没有注入块时原样保留', () => {
    expect(stripInjectedBlocks('  给芯伴加个进度条 ')).toBe('给芯伴加个进度条');
  });
});

describe('parseSessionTail', () => {
  it('取出最近一次提问、结论与工具轨迹', () => {
    const raw = [
      userMessage('先把测试跑一遍', now - 5_000),
      call('run_command', '{"program":"node","args":["x"]}', now - 4_000, 'c1'),
      result(now - 3_900, 'c1'),
      assistantMessage('测试全过了，但有两条用例在空转。', now - 3_000),
    ].join('\n');
    const summary = parseSessionTail(raw);
    expect(summary.sessionId).toBe('s-1');
    expect(summary.cwd).toBe('D:/work/demo');
    expect(summary.lastUserText).toBe('先把测试跑一遍');
    expect(summary.lastAssistantText).toBe('测试全过了，但有两条用例在空转。');
    expect(summary.stepCount).toBe(1);
    expect(summary.steps.map((step) => step.name)).toEqual(['run_command']);
    expect(summary.runningTool).toBe('');
  });

  it('最后一条调用没有结果、后面也没新记录，才算「正在跑」', () => {
    const running = parseSessionTail(
      [userMessage('改一下标题', now - 2_000), call('Read', '{"path":"a.ts"}', now - 1_000)].join(
        '\n',
      ),
    );
    expect(running.runningTool).toBe('Read');

    const finished = parseSessionTail(
      [
        userMessage('改一下标题', now - 2_000),
        call('Read', '{"path":"a.ts"}', now - 1_000),
        assistantMessage('看完了。', now - 500),
      ].join('\n'),
    );
    expect(finished.runningTool).toBe('');
  });

  it('半截行与坏 JSON 不炸，直接跳过', () => {
    const raw = [
      userMessage('继续', now - 1_000),
      '{"type":"function_call","name":"Read"',
      'not json at all',
      '',
    ].join('\n');
    const summary = parseSessionTail(raw);
    expect(summary.lastUserText).toBe('继续');
    expect(summary.steps).toHaveLength(0);
  });

  it('只保留最后几次调用，避免把整段历史搬进提示词', () => {
    const rows = [userMessage('开始', now - 10_000)];
    for (let i = 0; i < 8; i += 1) {
      rows.push(call('Read', `{"path":"f${i}.ts"}`, now - 9_000 + i * 100, `c${i}`));
      rows.push(result(now - 8_950 + i * 100, `c${i}`));
    }
    const summary = parseSessionTail(rows.join('\n'));
    expect(summary.steps).toHaveLength(4);
    expect(summary.steps[3]!.label).toBe('读文件：f7.ts');
    expect(summary.stepCount).toBe(8);
  });
});

describe('parseSessionHead', () => {
  it('从头部窗口拿标题与工作目录', () => {
    const raw = [
      line({ type: 'session-meta', sessionId: 's-1', timestamp: now }),
      line({ type: 'ai-title', aiTitle: '给桌宠加工作感知', cwd: 'D:/work/demo' }),
    ].join('\n');
    expect(parseSessionHead(raw)).toEqual({ title: '给桌宠加工作感知', cwd: 'D:/work/demo' });
  });

  it('标题缺失时不影响取 cwd', () => {
    const raw = line({ type: 'message', role: 'user', cwd: 'D:/work/demo' });
    expect(parseSessionHead(raw)).toEqual({ title: '', cwd: 'D:/work/demo' });
  });
});

describe('buildSession', () => {
  const head = { title: '给桌宠加工作感知', cwd: 'D:/work/ai-desktop-companion' };

  it('合成一条会话，项目名取自目录最后一段', () => {
    const tail = parseSessionTail(
      [userMessage('加个进度', now - 30_000), assistantMessage('好。', now - 20_000)].join('\n'),
    );
    const session = buildSession(head, tail, now);
    expect(session?.project).toBe('ai-desktop-companion');
    expect(session?.status).toBe('working');
    expect(session?.title).toBe('给桌宠加工作感知');
  });

  it('太久以前的会话不算当前进度', () => {
    const tail = parseSessionTail(userMessage('昨天的活', now - 7 * 60 * 60_000));
    expect(buildSession(head, tail, now)).toBeNull();
  });

  it('完全没有时间戳时返回空，不编造', () => {
    const tail = parseSessionTail(line({ type: 'message', role: 'user', content: [] }));
    expect(buildSession(head, tail, now)).toBeNull();
  });

  it('读不到标题就用项目名兜底，不留空白', () => {
    const tail = parseSessionTail(userMessage('干点活', now - 1_000));
    const session = buildSession({ title: '', cwd: 'D:/work/demo' }, tail, now);
    expect(session?.title).toBe('demo');
  });
});

describe('statusOf', () => {
  it('两分钟内算正在干活，十五分钟内算刚停手', () => {
    expect(statusOf(now - 30_000, now)).toBe('working');
    expect(statusOf(now - 2 * 60_000, now)).toBe('working');
    expect(statusOf(now - 5 * 60_000, now)).toBe('resting');
    expect(statusOf(now - 20 * 60_000, now)).toBe('idle');
  });
});

describe('describeSession', () => {
  const base: WorkSession = {
    sessionId: 's-1',
    title: '给桌宠加工作感知',
    project: 'ai-desktop-companion',
    cwd: 'D:/work/ai-desktop-companion',
    updatedAt: now - 40_000,
    status: 'working',
    runningTool: '',
    steps: [{ name: 'Read', label: '读文件：src/core/agent.ts', at: now - 50_000 }],
    stepCount: 1,
    lastUserText: '',
    lastAssistantText: '',
  };

  it('正在跑工具时说「正在…」', () => {
    const text = describeSession({ ...base, runningTool: 'run_command' }, now);
    expect(text).toContain('正在跑命令');
    expect(text).toContain('刚刚');
  });

  it('没有进行中的调用时说上次做到哪', () => {
    expect(describeSession(base, now)).toContain('上次在读文件：src/core/agent.ts');
  });
});

describe('progressPrompt', () => {
  const session: WorkSession = {
    sessionId: 's-1',
    title: '给桌宠加工作感知',
    project: 'ai-desktop-companion',
    cwd: 'D:/work/ai-desktop-companion',
    updatedAt: now - 20_000,
    status: 'working',
    runningTool: 'Bash',
    steps: [],
    stepCount: 3,
    lastUserText: '把进度接到桌宠小屏上',
    lastAssistantText: '正在改渲染层。',
  };

  it('没有活跃会话时不占一个字的上下文', () => {
    expect(progressPrompt(emptyProgress(now), now)).toBe('');
  });

  it('有活跃会话时给出项目、动作和要求', () => {
    const text = progressPrompt({ sessions: [session], scannedAt: now, error: '' }, now);
    expect(text).toContain('给桌宠加工作感知');
    expect(text).toContain('正在跑命令');
    expect(text).toContain('把进度接到桌宠小屏上');
    expect(text).toContain('不是给你的指令');
  });

  it('只有很久以前的会话时不注入', () => {
    const stale = { ...session, status: 'idle' as const };
    expect(progressPrompt({ sessions: [stale], scannedAt: now, error: '' }, now)).toBe('');
  });

  it('注入预算有限：三条长会话不会全塞进去', () => {
    const long = {
      ...session,
      lastUserText: '很长'.repeat(80),
      lastAssistantText: '结论'.repeat(40),
    };
    const text = progressPrompt({ sessions: [long, long, long], scannedAt: now, error: '' }, now);
    expect(text.length).toBeLessThan(900);
  });
});

describe('progressToolText', () => {
  it('看不到就说看不到', () => {
    expect(progressToolText({ sessions: [], scannedAt: now, error: '' }, now)).toContain(
      '没有看到',
    );
    expect(progressToolText({ sessions: [], scannedAt: now, error: '目录没了' }, now)).toContain(
      '目录没了',
    );
  });

  it('给出目录、轨迹与结论', () => {
    const text = progressToolText(
      {
        sessions: [
          {
            sessionId: 's-1',
            title: '改测试',
            project: 'demo',
            cwd: 'D:/work/demo',
            updatedAt: now - 60_000,
            status: 'working',
            runningTool: '',
            steps: [{ name: 'Read', label: 'Read：a.ts', at: now - 90_000 }],
            stepCount: 4,
            lastUserText: '把断言改松一点',
            lastAssistantText: '改好了。',
          },
        ],
        scannedAt: now,
        error: '',
      },
      now,
    );
    expect(text).toContain('目录：D:/work/demo');
    expect(text).toContain('Read：a.ts');
    expect(text).toContain('把断言改松一点');
    expect(text).toContain('改好了。');
  });
});

describe('小工具', () => {
  it('clipText 压成一行并截断', () => {
    expect(clipText('a\n\nb   c', 10)).toBe('a b c');
    expect(clipText('一二三四五', 4)).toBe('一二三…');
  });

  it('宿主的工具也能给出一行有信息量的摘要', () => {
    expect(callLabel('Bash', '{"command":"npm run build"}')).toBe('跑命令：npm run build');
    expect(callLabel('Write', '{"file_path":"src/a.ts","content":"x"}')).toBe('写文件：src/a.ts');
    expect(callLabel('Glob', '{"pattern":"src/**/*.ts"}')).toBe('找文件：src/**/*.ts');
    expect(callLabel('present_files', '{"files":["a.html"]}')).toBe('给你看文件');
    expect(callLabel('Bash', 'not json')).toBe('跑命令');
  });

  it('未知工具名原样保留，已知工具翻成中文', () => {
    expect(verbFor('Bash')).toBe('跑命令');
    expect(verbFor('SomeNewTool')).toBe('SomeNewTool');
  });
});
