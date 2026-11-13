import {
  callLabel,
  clipText,
  parseLines,
  progressWindow,
  userTextOf,
  type Raw,
  type TailSummary,
  type WorkStep,
} from './progress';

/**
 * 其他 agent 的会话痕迹：Claude Code 与 Codex。
 *
 * 和 WorkBuddy 一样只是「读痕迹」：对方不推送事件，格式也不是公开契约，随时可能变。
 * 所以每个字段都容错：读不懂的记录跳过，读不出时间就当没这个会话，
 * 宁可「不知道」，不要说错。
 *
 * 两边的时间都是 ISO 字符串（WorkBuddy 是毫秒数），工具调用与结果靠 id 配对。
 */

export type AgentLogFormat = 'workbuddy' | 'claude-code' | 'codex';

export const agentSourceLabels: Record<AgentLogFormat, string> = {
  workbuddy: 'WorkBuddy',
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function obj(value: unknown): Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : {};
}

/** ISO 字符串或毫秒数 → 毫秒；读不出是 0。 */
export function timeOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** content 可能是字符串，也可能是块数组；只拼文本类的块。 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const item = obj(block);
    const type = str(item['type']);
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = str(item['text']);
      if (text !== '') parts.push(text);
    }
  }
  return parts.join('\n');
}

function argsText(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return '';
  }
}

interface Collector {
  steps: WorkStep[];
  stepCount: number;
  calls: { id: string; name: string; at: number }[];
  finished: Set<string>;
  sessionId: string;
  cwd: string;
  updatedAt: number;
  lastUserText: string;
  lastAssistantText: string;
}

function collector(): Collector {
  return {
    steps: [],
    stepCount: 0,
    calls: [],
    finished: new Set(),
    sessionId: '',
    cwd: '',
    updatedAt: 0,
    lastUserText: '',
    lastAssistantText: '',
  };
}

function call(c: Collector, id: string, name: string, args: string, at: number): void {
  if (name === '') return;
  c.calls.push({ id, name, at });
  c.steps.push({ name, label: callLabel(name, args), at });
}

function finish(c: Collector): TailSummary {
  let runningTool = '';
  let runningAt = 0;
  for (const item of c.calls) {
    if (item.id !== '' && !c.finished.has(item.id)) {
      runningTool = item.name;
      runningAt = item.at;
    }
  }
  // 和 WorkBuddy 同一条规矩：这条调用之后还有写入，就说明它已经过去了。
  if (runningTool !== '' && c.updatedAt > runningAt) runningTool = '';
  const stepCount = c.calls.filter((item) => item.id === '' || c.finished.has(item.id)).length;
  return {
    sessionId: c.sessionId,
    cwd: c.cwd,
    updatedAt: c.updatedAt,
    runningTool,
    steps: c.steps.slice(-progressWindow.maxSteps),
    stepCount,
    lastUserText: clipText(c.lastUserText, 160),
    lastAssistantText: clipText(c.lastAssistantText, 160),
  };
}

/**
 * Claude Code：`~/.claude/projects/<项目>/<会话>.jsonl`。
 * 记录形如 `{type:'user'|'assistant', timestamp, sessionId, cwd, message:{role, content}}`；
 * 工具调用是 assistant content 里的 `tool_use{id,name,input}`，结果是 user content 里的 `tool_result{tool_use_id}`。
 */
export function parseClaudeTail(raw: string): TailSummary {
  const c = collector();
  const records = parseLines(raw);
  for (const record of records) {
    const message = obj(record['message']);
    const content = message['content'];
    if (Array.isArray(content)) {
      for (const block of content) {
        const item = obj(block);
        if (str(item['type']) === 'tool_result') {
          const id = str(item['tool_use_id']);
          if (id !== '') c.finished.add(id);
        }
      }
    }
  }
  for (const record of records) {
    const type = str(record['type']);
    if (type !== 'user' && type !== 'assistant') continue;
    const at = timeOf(record['timestamp']);
    if (at > c.updatedAt) c.updatedAt = at;
    if (c.sessionId === '') c.sessionId = str(record['sessionId']);
    const cwd = str(record['cwd']);
    if (cwd !== '') c.cwd = cwd;
    const message = obj(record['message']);
    const content = message['content'];
    if (type === 'user') {
      // 工具结果也以 user 身份写入，那不是「你说的话」。
      if (record['isMeta'] === true) continue;
      const text = userTextOf(textOf(content));
      if (text !== '' && !text.startsWith('[Request interrupted')) c.lastUserText = text;
      continue;
    }
    const text = textOf(content);
    if (text.trim() !== '') c.lastAssistantText = text;
    if (Array.isArray(content)) {
      for (const block of content) {
        const item = obj(block);
        if (str(item['type']) === 'tool_use') {
          call(c, str(item['id']), str(item['name']), argsText(item['input']), at);
        }
      }
    }
  }
  return finish(c);
}

/** Claude Code 头部：标题来自 `summary` 记录（有就用），目录来自第一条带 cwd 的记录。 */
export function parseClaudeHead(raw: string): { title: string; cwd: string } {
  let title = '';
  let cwd = '';
  for (const record of parseLines(raw)) {
    const type = str(record['type']);
    if (title === '' && type === 'summary') title = str(record['summary']);
    if (title === '' && type === 'ai-title') title = str(record['aiTitle']) || str(record['title']);
    if (cwd === '') cwd = str(record['cwd']);
    if (title !== '' && cwd !== '') break;
  }
  return { title: clipText(title, 60), cwd };
}

/**
 * Codex：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`。
 * 记录形如 `{timestamp, type, payload}`：`session_meta{id,cwd}`、
 * `response_item{type:'message'|'function_call'|'function_call_output'|'local_shell_call'|...}`。
 */
export function parseCodexTail(raw: string): TailSummary {
  const c = collector();
  const records = parseLines(raw);
  for (const record of records) {
    const payload = obj(record['payload']);
    const kind = str(payload['type']);
    if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
      const id = str(payload['call_id']);
      if (id !== '') c.finished.add(id);
    }
  }
  for (const record of records) {
    const at = timeOf(record['timestamp']);
    if (at > c.updatedAt) c.updatedAt = at;
    const type = str(record['type']);
    const payload = obj(record['payload']);
    if (type === 'session_meta') {
      if (c.sessionId === '') c.sessionId = str(payload['id']);
      if (c.cwd === '') c.cwd = str(payload['cwd']);
      continue;
    }
    if (type === 'turn_context') {
      const cwd = str(payload['cwd']);
      if (cwd !== '') c.cwd = cwd;
      continue;
    }
    if (type !== 'response_item') continue;
    const kind = str(payload['type']);
    if (kind === 'message') {
      const role = str(payload['role']);
      const text = textOf(payload['content']);
      if (role === 'user') {
        const clean = userTextOf(text);
        // Codex 会把环境说明以 user 消息形式写进来，形如 <environment_context>……
        if (clean !== '') c.lastUserText = clean;
      } else if (role === 'assistant' && text.trim() !== '') {
        c.lastAssistantText = text;
      }
    } else if (kind === 'function_call' || kind === 'custom_tool_call') {
      call(
        c,
        str(payload['call_id']),
        str(payload['name']),
        str(payload['arguments']) || str(payload['input']),
        at,
      );
    } else if (kind === 'local_shell_call') {
      const action = obj(payload['action']);
      const command = Array.isArray(action['command']) ? action['command'].map(str).join(' ') : '';
      // 本地 shell 调用没有单独的结果记录可配对：当作已完成的一步。
      call(c, '', 'shell', JSON.stringify({ command }), at);
    }
  }
  return finish(c);
}

/** Codex 头部：没有标题，只拿目录；标题由项目名兜底。 */
export function parseCodexHead(raw: string): { title: string; cwd: string } {
  for (const record of parseLines(raw)) {
    if (str(record['type']) === 'session_meta') {
      return { title: '', cwd: str(obj(record['payload'])['cwd']) };
    }
  }
  return { title: '', cwd: '' };
}

/** 面板开关：除 WorkBuddy 外的来源默认关闭——它们的对话内容会随进度进入提问。 */
export interface AgentSourcesConfig {
  claudeCode: boolean;
  codex: boolean;
}

export const defaultAgentSources: AgentSourcesConfig = { claudeCode: false, codex: false };

export function normalizeAgentSources(raw: unknown): AgentSourcesConfig {
  const value = obj(raw);
  return { claudeCode: value['claudeCode'] === true, codex: value['codex'] === true };
}
