import { z } from 'zod';
import { simulationEventSchema, type SimulationEvent } from './schema';

/**
 * F-12 可保存的回放序列。
 *
 * 脚本只包含模拟事件（不含个人数据），最多 30 条；导入时逐条走与实时事件相同的
 * ingest 规则（去重、乱序、终态保护、断线丢弃），用于复现一致性问题。
 */
export const replayScriptSchema = z
  .object({
    kind: z.literal('xinban-replay-script'),
    version: z.literal(1),
    events: z.array(simulationEventSchema).min(1).max(30),
  })
  .strict();
export type ReplayScript = z.infer<typeof replayScriptSchema>;

export const replayCapacity = 30;
/** 主进程读取脚本文件的上限，避免打开超大文件。 */
export const replayFileLimit = 2 * 1024 * 1024;

export function buildReplayScript(events: readonly SimulationEvent[]): ReplayScript | null {
  const recent = events.slice(-replayCapacity);
  return recent.length > 0
    ? { kind: 'xinban-replay-script', version: 1, events: [...recent] }
    : null;
}

export function replayScriptText(events: readonly SimulationEvent[]): string | null {
  const script = buildReplayScript(events);
  return script ? JSON.stringify(script, null, 2) : null;
}

export type ReplayParseResult =
  { ok: true; events: SimulationEvent[] } | { ok: false; error: string };

export function parseReplayScript(raw: string): ReplayParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: '回放脚本不是有效的 JSON。' };
  }
  const parsed = replayScriptSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: '回放脚本格式不合法：需为 1–30 条符合模拟事件 schema 的记录。',
    };
  }
  return { ok: true, events: parsed.data.events };
}
