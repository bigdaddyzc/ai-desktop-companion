/**
 * 运行日志的纯逻辑：一行怎么写、哪些字段能进日志、哪些文件该删。
 *
 * 底线：日志只记「发生了什么」，不记「说了什么」。
 * 不写对话内容、记忆原文、命令全文、密钥；出了问题拿日志给别人看也不泄隐私。
 */

export type LogLevel = 'info' | 'warn' | 'error';

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export const appLogLimits = {
  keepDays: 7,
  /** 单个字段值最多多少字：错误信息够看懂就行，长了多半是夹带了内容。 */
  maxValue: 160,
  /** 面板上留最近几条告警。 */
  recent: 8,
} as const;

export interface LogRecord {
  at: number;
  level: LogLevel;
  event: string;
  fields: LogFields;
}

export interface HealthSnapshot {
  startedAt: number;
  version: string;
  logDir: string;
  /** 本次启动以来的告警/错误数。 */
  warnings: number;
  errors: number;
  /** 最近几条 warn/error，新的在前。 */
  recent: LogRecord[];
  /** 日志写不进去（磁盘满、权限）：面板要说出来，否则出事时才发现没留痕迹。 */
  writeFailed: boolean;
}

const pad = (value: number): string => `${value}`.padStart(2, '0');

export function logFileName(at: number): string {
  const day = new Date(at);
  return `app-${day.getFullYear()}${pad(day.getMonth() + 1)}${pad(day.getDate())}.log`;
}

/** 密钥长得很有特点：就算调用方不小心传进来，也在这里遮掉。 */
export function redact(text: string): string {
  return text
    .replace(/\b(sk|pk|rk|ak)-[A-Za-z0-9_-]{8,}/g, '$1-***')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/\b(api[_-]?key|token|password|secret)\s*[=:]\s*\S+/gi, '$1=***')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '***');
}

function clean(value: LogFields[string]): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number')
    return Number.isFinite(value) ? `${Math.round(value * 100) / 100}` : null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = redact(value.replace(/\s+/g, ' ').trim());
  if (text === '') return null;
  return text.length > appLogLimits.maxValue
    ? `${text.slice(0, appLogLimits.maxValue - 1)}…`
    : text;
}

/** 一行一条 JSON：人能看、grep 能搜、以后要统计也好解析。 */
export function formatLogLine(record: LogRecord): string {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(record.fields)) {
    const text = clean(value);
    if (text !== null && /^[a-zA-Z][\w]{0,31}$/.test(key)) fields[key] = text;
  }
  return `${JSON.stringify({
    t: new Date(record.at).toISOString(),
    lv: record.level,
    ev: record.event.slice(0, 48),
    ...fields,
  })}\n`;
}

/** 超过保留期的日志文件名。只认自己的命名，别的文件一概不碰。 */
export function expiredLogs(names: readonly string[], now: number): string[] {
  const cutoff = new Date(now - appLogLimits.keepDays * 86_400_000);
  const floor = `app-${cutoff.getFullYear()}${pad(cutoff.getMonth() + 1)}${pad(cutoff.getDate())}.log`;
  return names.filter((name) => /^app-\d{8}\.log$/.test(name) && name < floor);
}
