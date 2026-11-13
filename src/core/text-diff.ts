/**
 * 给确认卡看的改动摘要。
 *
 * 不做通用 diff 算法：去掉首尾相同的行，中间那一块就是改动。
 * 对 edit_file（只换一段）恰好精确；对整篇重写会把中间整块列为删/增，冗长但不会漏。
 */

export interface TextChange {
  removed: number;
  added: number;
  /** 带 - / + / 空格前缀的行，前后各留 context 行。 */
  lines: string[];
  /** 改动从第几行开始（1 起）。 */
  startLine: number;
}

export function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.replace(/\r\n/g, '\n').split('\n');
}

export function textChange(before: string, after: string, context = 2): TextChange {
  const a = splitLines(before);
  const b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  const from = Math.max(0, head - context);
  const lines = [
    ...a.slice(from, head).map((line) => `  ${line}`),
    ...removed.map((line) => `- ${line}`),
    ...added.map((line) => `+ ${line}`),
    ...a
      .slice(a.length - tail, Math.min(a.length, a.length - tail + context))
      .map((line) => `  ${line}`),
  ];
  return { removed: removed.length, added: added.length, lines, startLine: head + 1 };
}

/** 拼成卡片详情：超长时只显示前面若干行，并写明还有多少行没显示。 */
export function changeDetail(head: string, change: TextChange, maxChars: number): string {
  const summary = `${head}\n第 ${change.startLine} 行起：删 ${change.removed} 行、加 ${change.added} 行`;
  if (change.lines.length === 0) return `${summary}（内容没有变化）`;
  const shown: string[] = [];
  let used = summary.length;
  for (const line of change.lines) {
    const piece = line.length > 300 ? `${line.slice(0, 299)}…` : line;
    if (used + piece.length + 1 > maxChars) break;
    shown.push(piece);
    used += piece.length + 1;
  }
  const hidden = change.lines.length - shown.length;
  return [summary, ...shown, ...(hidden > 0 ? [`……还有 ${hidden} 行改动没显示`] : [])].join('\n');
}
