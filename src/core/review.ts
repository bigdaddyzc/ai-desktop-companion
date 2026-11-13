import { stripAnsi } from './delegate';
import { clipText } from './progress';

/**
 * 干完可审：结果卡上的「结论 / 改了什么 / 测试结果」。
 *
 * 改了什么只看 git（只读、固定参数、限时限长，在 desktop/review.ts 跑）；
 * 测试结果只从 Agent 自己的输出里认常见摘要行，**芯伴不自己跑测试**。
 * 纯领域层：只解析文本。
 */

export const reviewLimits = {
  gitTimeoutMs: 5_000,
  /** git status / numstat 输出上限。 */
  statBytes: 64 * 1024,
  /** 完整 diff 在面板里只读展示的上限。 */
  diffBytes: 200 * 1024,
  maxFiles: 200,
  maxTests: 3,
  conclusionChars: 600,
} as const;

/** 对方输出的最后一段当结论：取尾部非空段落。 */
export function conclusionOf(text: string): string {
  const clean = stripAnsi(text).trim();
  if (clean === '') return '';
  const paragraphs = clean.split(/\n\s*\n/).filter((part) => part.trim() !== '');
  const last = paragraphs[paragraphs.length - 1] ?? clean;
  return clipText(last, reviewLimits.conclusionChars);
}

const testLine = [
  // vitest / jest
  /^\s*Tests?:?\s+.*\b\d+\s+(passed|failed)\b/i,
  // pytest
  /^=+\s.*\b\d+\s+(passed|failed|error)s?\b.*\bin\s+[\d.]+s/i,
  // maven / gradle surefire
  /^\s*(\[\w+\]\s*)?Tests run:\s*\d+,\s*Failures:\s*\d+/i,
  // go test
  /^(ok|FAIL)\s+\S+\s+[\d.]+s\b/,
  // cargo test
  /^test result:\s+(ok|FAILED)\./,
];

/** 认得出的测试摘要行，最多 3 条（取最后出现的）。认不出就是空数组。 */
export function testSummaryLines(text: string): string[] {
  const found: string[] = [];
  for (const raw of stripAnsi(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.length > 300) continue;
    if (testLine.some((pattern) => pattern.test(line))) {
      const clipped = clipText(line, 120);
      const index = found.indexOf(clipped);
      if (index >= 0) found.splice(index, 1);
      found.push(clipped);
    }
  }
  return found.slice(-reviewLimits.maxTests);
}

export interface ChangedFile {
  path: string;
  /** 两位 porcelain 状态，例如 " M"、"??"、"A "。 */
  status: string;
  /** 二进制或未跟踪的是 null。 */
  added: number | null;
  deleted: number | null;
}

export interface ReviewResult {
  /** git：是 git 仓库；not-git：不是；no-dir：不知道在哪干的；error：git 跑不了。 */
  status: 'git' | 'not-git' | 'no-dir' | 'error';
  files: ChangedFile[];
  added: number;
  deleted: number;
  /** 一句话说明（非 git 等情况）。 */
  note: string;
  truncated: boolean;
  /** 当前 HEAD；和开工基线不同说明期间有新提交，提交进去的改动不在工作区 diff 里。 */
  head?: string;
}

/** 结果卡上对「改了什么」的诚实说明：工作区 diff 不等于这次任务的成果。 */
export function baselineNotes(
  baseline: { head: string; dirty: number } | undefined,
  head: string | undefined,
): string[] {
  const notes: string[] = [];
  if (baseline === undefined) {
    notes.push('没有开工前的记录：下面是当前工作区的全部改动，可能包含你或其他任务的修改。');
    return notes;
  }
  notes.push(
    baseline.dirty > 0
      ? `开工时已有 ${baseline.dirty} 个文件未提交：下面的改动不全是这次派活做的。`
      : '开工时工作区是干净的；期间若有你或其他任务改动，也会出现在下面。',
  );
  if (head !== undefined && head !== '' && head !== baseline.head) {
    notes.push('开工后有新提交（HEAD 变了）：已经提交进去的改动不在下面，去 git log 看。');
  }
  return notes;
}

/** `git status --porcelain=v1 -z`：路径原样，重命名取新路径。 */
export function parsePorcelain(raw: string): { path: string; status: string }[] {
  const out: { path: string; status: string }[] = [];
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    out.push({ status, path: entry.slice(3) });
    // 重命名/复制后面跟着原路径，跳过。
    if (status[0] === 'R' || status[0] === 'C') i += 1;
  }
  return out;
}

/** `git diff --numstat -z HEAD`：增删行数。 */
export function parseNumstat(
  raw: string,
): Map<string, { added: number | null; deleted: number | null }> {
  const out = new Map<string, { added: number | null; deleted: number | null }>();
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]!;
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(entry);
    if (!match) continue;
    let path = match[3]!;
    // 重命名时路径为空，后面两段是旧、新路径。
    if (path === '') {
      path = parts[i + 2] ?? '';
      i += 2;
    }
    out.set(path, {
      added: match[1] === '-' ? null : Number(match[1]),
      deleted: match[2] === '-' ? null : Number(match[2]),
    });
  }
  return out;
}

export function buildReview(porcelain: string, numstat: string, truncated: boolean): ReviewResult {
  const stats = parseNumstat(numstat);
  const files = parsePorcelain(porcelain)
    .slice(0, reviewLimits.maxFiles)
    .map((entry) => {
      const stat = stats.get(entry.path);
      return {
        path: entry.path,
        status: entry.status,
        added: stat?.added ?? null,
        deleted: stat?.deleted ?? null,
      };
    });
  let added = 0;
  let deleted = 0;
  for (const file of files) {
    added += file.added ?? 0;
    deleted += file.deleted ?? 0;
  }
  return {
    status: 'git',
    files,
    added,
    deleted,
    note: files.length === 0 ? '工作区是干净的：没有未提交的改动。' : '',
    truncated: truncated || parsePorcelain(porcelain).length > reviewLimits.maxFiles,
  };
}

export function reviewNote(status: ReviewResult['status']): string {
  switch (status) {
    case 'not-git':
      return '不是 git 项目，看不到改动。';
    case 'no-dir':
      return '不知道它在哪个目录干的，看不到改动。';
    case 'error':
      return 'git 没跑起来（没装 git，或超时了）。';
    case 'git':
      return '';
  }
}

/**
 * 「在编辑器打开」的命令：程序名或路径，不带参数。
 * Windows 上要经 cmd 启动 code.cmd 一类批处理，所以拒绝 cmd 的元字符。
 */
export function editorProblem(command: string): string {
  const value = command.trim();
  if (value === '') return '编辑器命令是空的。';
  if (value.length > 260) return '编辑器命令太长了。';
  if (/["&|<>^%!`$;\r\n]/.test(value))
    return '编辑器命令里不能有引号、& | < > ^ % ! ` $ ; 这类符号。';
  return '';
}

/** 要打开的目录同样不能带 cmd 元字符（路径来自钩子收件箱，是外部输入）。 */
export function openPathProblem(path: string): string {
  if (path === '') return '不知道它在哪个目录干的。';
  if (/["&|<>^%!`\r\n]/.test(path)) return '这个目录名里有特殊符号，芯伴不替你打开。';
  return '';
}
