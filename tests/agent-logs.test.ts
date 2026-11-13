import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  normalizeAgentSources,
  parseClaudeHead,
  parseClaudeTail,
  parseCodexHead,
  parseCodexTail,
  timeOf,
} from '../src/core/agent-logs';
import {
  CodexProgressSource,
  FsProgressSource,
  MultiProgressSource,
  ProgressService,
} from '../src/desktop/progress';

const lines = (...records: unknown[]): string => records.map((r) => JSON.stringify(r)).join('\n');
const iso = (ms: number): string => new Date(ms).toISOString();
const t0 = Date.UTC(2026, 10, 9, 2, 0, 0);

describe('Claude Code logs', () => {
  const user = (text: string, at: number, extra: Record<string, unknown> = {}) => ({
    type: 'user',
    timestamp: iso(at),
    sessionId: 'cc1',
    cwd: 'D:\\work\\demo',
    message: { role: 'user', content: text },
    ...extra,
  });
  const toolUse = (id: string, name: string, at: number, input: unknown = {}) => ({
    type: 'assistant',
    timestamp: iso(at),
    sessionId: 'cc1',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
  const toolResult = (id: string, at: number) => ({
    type: 'user',
    timestamp: iso(at),
    sessionId: 'cc1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  });

  it('pairs tool_use with tool_result and keeps the last words', () => {
    const raw = lines(
      user('帮我修登录', t0),
      toolUse('t1', 'Read', t0 + 1_000, { file_path: 'src/login.ts' }),
      toolResult('t1', t0 + 2_000),
      {
        type: 'assistant',
        timestamp: iso(t0 + 3_000),
        message: { role: 'assistant', content: [{ type: 'text', text: '修好了，去跑测试吧' }] },
      },
    );
    const tail = parseClaudeTail(raw);
    expect(tail).toMatchObject({
      sessionId: 'cc1',
      cwd: 'D:\\work\\demo',
      updatedAt: t0 + 3_000,
      runningTool: '',
      stepCount: 1,
      lastUserText: '帮我修登录',
      lastAssistantText: '修好了，去跑测试吧',
    });
    expect(tail.steps[0]?.name).toBe('Read');
  });

  it('reports a pending question as the running tool', () => {
    const raw = lines(user('继续', t0), toolUse('q1', 'AskUserQuestion', t0 + 500));
    expect(parseClaudeTail(raw).runningTool).toBe('AskUserQuestion');
  });

  it('tool results are not mistaken for what the user said', () => {
    const raw = lines(
      user('真正的问题', t0),
      toolUse('a', 'Bash', t0 + 1),
      toolResult('a', t0 + 2),
    );
    expect(parseClaudeTail(raw).lastUserText).toBe('真正的问题');
  });

  it('survives junk, half lines and unknown record types', () => {
    const raw = `not json\n{"type":"summary","summary":"登录修复"}\n${JSON.stringify(user('hi', t0))}\n{"type":"assist`;
    expect(parseClaudeTail(raw).updatedAt).toBe(t0);
    expect(parseClaudeHead(raw)).toEqual({ title: '登录修复', cwd: 'D:\\work\\demo' });
  });
});

describe('Codex logs', () => {
  const meta = {
    timestamp: iso(t0),
    type: 'session_meta',
    payload: { id: 'cx1', cwd: '/home/me/api' },
  };
  const item = (payload: Record<string, unknown>, at: number) => ({
    timestamp: iso(at),
    type: 'response_item',
    payload,
  });

  it('reads meta, messages and function calls', () => {
    const raw = lines(
      meta,
      item(
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '加个接口' }] },
        t0 + 1,
      ),
      item(
        { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'c1' },
        t0 + 2,
      ),
      item({ type: 'function_call_output', call_id: 'c1', output: 'ok' }, t0 + 3),
      item(
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已加好' }] },
        t0 + 4,
      ),
    );
    expect(parseCodexTail(raw)).toMatchObject({
      sessionId: 'cx1',
      cwd: '/home/me/api',
      updatedAt: t0 + 4,
      runningTool: '',
      stepCount: 1,
      lastUserText: '加个接口',
      lastAssistantText: '已加好',
    });
    expect(parseCodexHead(raw)).toEqual({ title: '', cwd: '/home/me/api' });
  });

  it('an unanswered call that is the last record is running', () => {
    const raw = lines(
      meta,
      item({ type: 'function_call', name: 'apply_patch', call_id: 'c9' }, t0 + 9),
    );
    expect(parseCodexTail(raw).runningTool).toBe('apply_patch');
  });

  it('strips injected environment context from user text', () => {
    const raw = lines(
      meta,
      item(
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '<environment_context>cwd=/x</environment_context>' },
          ],
        },
        t0 + 1,
      ),
      item(
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '修 bug' }] },
        t0 + 2,
      ),
    );
    expect(parseCodexTail(raw).lastUserText).toBe('修 bug');
  });
});

describe('helpers', () => {
  it('timeOf accepts ISO and numbers', () => {
    expect(timeOf(iso(t0))).toBe(t0);
    expect(timeOf(t0)).toBe(t0);
    expect(timeOf('nope')).toBe(0);
  });

  it('agent sources default to off', () => {
    expect(normalizeAgentSources(undefined)).toEqual({ claudeCode: false, codex: false });
    expect(normalizeAgentSources({ claudeCode: true, codex: 'yes' })).toEqual({
      claudeCode: true,
      codex: false,
    });
  });
});

describe('multi-source progress', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xinban-agents-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('labels Claude Code and Codex sessions, leaves WorkBuddy unlabelled', async () => {
    const now = Date.now();
    const claudeDir = join(dir, 'claude', 'demo');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, 'cc1.jsonl'),
      lines({
        type: 'assistant',
        timestamp: iso(now - 10_000),
        sessionId: 'cc1',
        cwd: 'D:\\work\\demo',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: {} }],
        },
      }),
    );
    const day = new Date(now);
    const pad = (value: number) => `${value}`.padStart(2, '0');
    const codexDir = join(
      dir,
      'codex',
      `${day.getFullYear()}`,
      pad(day.getMonth() + 1),
      pad(day.getDate()),
    );
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      join(codexDir, 'rollout-1.jsonl'),
      lines(
        {
          timestamp: iso(now - 20_000),
          type: 'session_meta',
          payload: { id: 'cx1', cwd: '/srv/api' },
        },
        {
          timestamp: iso(now - 15_000),
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'done' }],
          },
        },
      ),
    );
    const missing = new FsProgressSource(join(dir, 'no-workbuddy'));
    const service = new ProgressService(
      new MultiProgressSource(() => [
        missing,
        new FsProgressSource(join(dir, 'claude'), 'claude-code'),
        new CodexProgressSource(join(dir, 'codex')),
      ]),
    );
    const state = await service.scan();
    expect(state.error).toBe('');
    const bySource = Object.fromEntries(state.sessions.map((s) => [s.source, s]));
    expect(bySource['Claude Code']).toMatchObject({
      project: 'demo',
      runningTool: 'AskUserQuestion',
    });
    expect(bySource['Codex']).toMatchObject({ project: 'api', lastAssistantText: 'done' });
  });

  it('reports not-found only when every source is missing', async () => {
    const service = new ProgressService(
      new MultiProgressSource(() => [
        new FsProgressSource(join(dir, 'a')),
        new CodexProgressSource(join(dir, 'b')),
      ]),
    );
    expect((await service.scan()).error).not.toBe('');
  });
});
