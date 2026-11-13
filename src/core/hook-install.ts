/**
 * 把芯伴的钩子装进 / 卸出 Claude Code 的 settings.json 与 Codex 的 config.toml。
 *
 * 这是在改用户自己的配置文件，所以三条底线：
 * 1. 只动带 `xinban-hook` 记号的条目，用户自己的钩子一条不碰；
 * 2. 读不懂就不写（settings.json 不是对象、Codex 里已有别人的 notify），把原因交回去；
 * 3. 装两次和装一次结果相同，卸载后回到没装时的样子。
 *
 * 本文件只处理文本与对象，读写文件、备份在 desktop/hooks.ts。
 */

export const hookMark = 'xinban-hook';

/**
 * workbuddy：WorkBuddy 自带的 CodeBuddy 引擎用和 Claude Code 同一套 hooks 格式
 * （同样的事件名、hook_event_name / session_id / notification_type、type:'command' + async），
 * 配置在 ~/.workbuddy/settings.json（尊重 WORKBUDDY_CONFIG_DIR）。所以装卸直接复用 Claude 那套。
 *
 * codebuddy：完整版 CodeBuddy 命令行（LOCALAPPDATA\codebuddy\bin\codebuddy.exe）是另一个产品身份，
 * 读 ~/.codebuddy/settings.json。芯伴「替它派活」选 WorkBuddy 时跑的就是它，实测钩子只认这一份。
 * 事件仍记为 workbuddy 来源：对用户来说都是「WorkBuddy 在干活」。
 */
export const hookTargets = ['claude-code', 'codex', 'workbuddy', 'codebuddy'] as const;
export type HookTarget = (typeof hookTargets)[number];

export function isHookTarget(value: unknown): value is HookTarget {
  return typeof value === 'string' && (hookTargets as readonly string[]).includes(value);
}

export interface HookTargetStatus {
  status: 'installed' | 'partial' | 'absent' | 'conflict' | 'unreadable';
  path: string;
  note: string;
}

export interface HooksStatus {
  claudeCode: HookTargetStatus;
  codex: HookTargetStatus;
  workbuddy: HookTargetStatus;
  codebuddy: HookTargetStatus;
  /** 钩子命令用 node 跑；找不到 node 时装上也不会触发。 */
  node: boolean;
  /** 收件箱最后一次收到事件的时间；0 表示从没收到。 */
  lastEventAt: number;
}

/**
 * 要监听的 Claude Code 事件。只用存在已久的事件名：老版本不认识的事件名可能让整份配置报错。
 * PostToolUse 是为了知道「你批准了、它接着干了」，否则等待状态要拖到这一轮结束才清。
 */
export const claudeHookEvents = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd',
] as const;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOurs(handler: unknown): boolean {
  return isObject(handler) && typeof handler['command'] === 'string'
    ? handler['command'].includes(hookMark)
    : false;
}

/** 拆掉一个事件下我们的处理器；组里没别的处理器了就把整组拿掉。 */
function withoutOurs(groups: unknown): unknown[] {
  if (!Array.isArray(groups)) return [];
  const out: unknown[] = [];
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group['hooks'])) {
      out.push(group);
      continue;
    }
    const hooks = group['hooks'].filter((handler) => !isOurs(handler));
    if (hooks.length === group['hooks'].length) out.push(group);
    else if (hooks.length > 0) out.push({ ...group, hooks });
  }
  return out;
}

export type InstallResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** settings.json 的原文 → 对象。空文件算 {}；不是 JSON 对象就拒绝，绝不覆盖。 */
export function parseClaudeSettings(text: string): InstallResult<Json> {
  if (text.trim() === '') return { ok: true, value: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'settings.json 不是合法的 JSON，没敢动它。' };
  }
  if (!isObject(value)) return { ok: false, error: 'settings.json 的最外层不是对象，没敢动它。' };
  if (value['hooks'] !== undefined && !isObject(value['hooks'])) {
    return { ok: false, error: 'settings.json 里的 hooks 不是对象，没敢动它。' };
  }
  return { ok: true, value };
}

/**
 * 替你确认与远程批准要当场给出答复，只有这个事件同步跑；对方会忽略异步钩子的输出。
 * 远程批准开着时脚本会等你回答（最长 90 秒，实际等多久看 remote.json）；
 * 超时对方就照常弹窗。
 */
export const syncHookEvents: readonly string[] = ['PermissionRequest'];

/** 同步钩子的 timeout（秒）：远程批准最长等待 90 秒 + 5 秒余量。改了旧安装算 partial。 */
export const syncHookTimeoutSec = 95;

function ourHandler(event: string, command: string): Json {
  return syncHookEvents.includes(event)
    ? { type: 'command', command, timeout: syncHookTimeoutSec }
    : { type: 'command', command, async: true, timeout: 10 };
}

/** 装：先拆掉我们旧的，再给每个事件追加一组。除了权限请求都是 async：观察者不拖慢对方。 */
export function installClaudeHooks(settings: Json, command: string): Json {
  const hooks: Json = { ...(isObject(settings['hooks']) ? settings['hooks'] : {}) };
  for (const event of claudeHookEvents) {
    hooks[event] = [...withoutOurs(hooks[event]), { hooks: [ourHandler(event, command)] }];
  }
  return { ...settings, hooks };
}

export function uninstallClaudeHooks(settings: Json): Json {
  if (!isObject(settings['hooks'])) return settings;
  const hooks: Json = {};
  for (const [event, groups] of Object.entries(settings['hooks'])) {
    const kept = Array.isArray(groups) ? withoutOurs(groups) : groups;
    if (Array.isArray(kept) && kept.length === 0) continue;
    hooks[event] = kept;
  }
  const next: Json = { ...settings };
  if (Object.keys(hooks).length === 0) delete next['hooks'];
  else next['hooks'] = hooks;
  return next;
}

/**
 * 装全了才算装上；只剩一部分（用户手工删过）算 partial，提示重装。
 * 老版本把权限请求也装成了 async（替你确认不生效）、或 timeout 太短（远程批准等不完），
 * 同样算 partial。
 */
export function claudeHooksStatus(settings: Json): 'installed' | 'partial' | 'absent' {
  const hooks = isObject(settings['hooks']) ? settings['hooks'] : {};
  let found = 0;
  let stale = false;
  for (const event of claudeHookEvents) {
    const groups = hooks[event];
    const ours = Array.isArray(groups)
      ? groups.flatMap((group) =>
          isObject(group) && Array.isArray(group['hooks']) ? group['hooks'].filter(isOurs) : [],
        )
      : [];
    if (ours.length > 0) found += 1;
    if (
      syncHookEvents.includes(event) &&
      ours.some(
        (handler) =>
          isObject(handler) &&
          (handler['async'] === true || handler['timeout'] !== syncHookTimeoutSec),
      )
    ) {
      stale = true;
    }
  }
  if (found === 0) return 'absent';
  return found === claudeHookEvents.length && !stale ? 'installed' : 'partial';
}

/* ---------------- Codex ---------------- */

/** 顶层 notify 必须写在第一个 [表] 之前，否则会被当成那个表的字段。 */
function topLevelEnd(lines: readonly string[]): number {
  const index = lines.findIndex((line) => /^\s*\[/.test(line));
  return index < 0 ? lines.length : index;
}

function notifyLine(lines: readonly string[]): number {
  const end = topLevelEnd(lines);
  for (let i = 0; i < end; i += 1) if (/^\s*notify\s*=/.test(lines[i]!)) return i;
  return -1;
}

/** TOML 基本字符串与 JSON 字符串的转义规则在这里用到的范围内一致。 */
export function codexNotifyValue(argv: readonly string[]): string {
  return `notify = [${argv.map((arg) => JSON.stringify(arg)).join(', ')}] # ${hookMark}`;
}

export function codexNotifyStatus(toml: string): 'installed' | 'absent' | 'conflict' {
  const lines = toml.split(/\r?\n/);
  const index = notifyLine(lines);
  if (index < 0) return 'absent';
  return lines[index]!.includes(hookMark) ? 'installed' : 'conflict';
}

/**
 * 装：没有 notify 就加在顶层；有我们的就替换；有别人的就拒绝——Codex 只认一个 notify，
 * 覆盖会让用户原来的通知脚本不声不响地失效。
 */
export function installCodexNotify(toml: string, argv: readonly string[]): InstallResult<string> {
  const newline = toml.includes('\r\n') ? '\r\n' : '\n';
  const lines = toml === '' ? [] : toml.split(/\r?\n/);
  const index = notifyLine(lines);
  const line = codexNotifyValue(argv);
  if (index >= 0) {
    if (!lines[index]!.includes(hookMark)) {
      return {
        ok: false,
        error: 'Codex 的 config.toml 里已经有你自己的 notify，芯伴不覆盖它。',
      };
    }
    lines[index] = line;
    return { ok: true, value: lines.join(newline) };
  }
  // 写在文件最前面：一定在任何 [表] 之前。
  const body = lines.join(newline);
  return { ok: true, value: body === '' ? `${line}${newline}` : `${line}${newline}${body}` };
}

export function uninstallCodexNotify(toml: string): string {
  const newline = toml.includes('\r\n') ? '\r\n' : '\n';
  const lines = toml.split(/\r?\n/);
  const index = notifyLine(lines);
  if (index < 0 || !lines[index]!.includes(hookMark)) return toml;
  lines.splice(index, 1);
  return lines.join(newline);
}

/** 钩子命令里的路径一律用正斜杠：Git Bash、PowerShell、cmd 都认，反斜杠在 bash 里会被吃掉。 */
export function slashPath(path: string): string {
  return path.replace(/\\/g, '/');
}

export function claudeHookCommand(
  nodeBin: string,
  script: string,
  inbox: string,
  source: 'claude' | 'workbuddy' = 'claude',
): string {
  const quote = (value: string): string => `"${slashPath(value)}"`;
  return `${nodeBin} ${quote(script)} ${source} ${quote(inbox)}`;
}

export function codexNotifyArgv(nodeBin: string, script: string, inbox: string): string[] {
  return [nodeBin, slashPath(script), 'codex', slashPath(inbox)];
}
