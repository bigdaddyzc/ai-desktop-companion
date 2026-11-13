/**
 * 把「到期时间」的文字解成时间戳。
 *
 * 来源有两个：面板里的 datetime-local 输入（`2026-11-10T15:00`），
 * 和模型在 add_todo 里填的 due（同样的格式，偶尔漏年份或带秒）。
 * 一律按本机时区理解；带时区后缀（Z / +08:00）的也接受。
 *
 * 这里不做自然语言解析（「明天下午」）——那是模型的活，它有「今天」的日期。
 */

export const dueLimits = {
  /** 最多允许设在多久以前：补记一件刚过点的事是合理的，设在去年不是。 */
  pastMs: 24 * 3_600_000,
  futureMs: 366 * 24 * 3_600_000,
} as const;

export type DueParse = { ok: true; at: number } | { ok: false; error: string };

export function parseDue(raw: string, now: number): DueParse {
  const text = raw.trim().replace(' ', 'T');
  if (text === '') return { ok: false, error: '到期时间为空。' };
  const match =
    /^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(
      text,
    );
  if (!match) return { ok: false, error: '到期时间格式应为 2026-11-10T15:00。' };
  const [, y, mo, d, h, mi, s, zone] = match;
  const year = y ? Number(y) : new Date(now).getFullYear();
  const parts = [year, Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0)] as const;
  let at: number;
  if (zone) {
    const iso = `${String(year).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${mi}:${String(s ?? '00').padStart(2, '0')}${zone === 'Z' ? 'Z' : zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`}`;
    at = Date.parse(iso);
  } else {
    const date = new Date(...parts);
    // new Date 会把 2 月 30 日悄悄滚到 3 月；滚了就说明日期不存在。
    if (
      date.getMonth() !== parts[1] ||
      date.getDate() !== parts[2] ||
      date.getHours() !== parts[3]
    ) {
      return { ok: false, error: '没有这一天或这个时刻。' };
    }
    at = date.getTime();
  }
  if (!Number.isFinite(at)) return { ok: false, error: '到期时间无法解析。' };
  if (at < now - dueLimits.pastMs) return { ok: false, error: '到期时间已经过去太久了。' };
  if (at > now + dueLimits.futureMs) return { ok: false, error: '到期时间太远了，最多一年。' };
  return { ok: true, at: Math.floor(at / 60_000) * 60_000 };
}

/** 时间戳 → datetime-local 输入框的值（本机时区）。 */
export function toLocalInput(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => `${value}`.padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
