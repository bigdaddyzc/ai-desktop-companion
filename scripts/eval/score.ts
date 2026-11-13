import type { EvalCase } from './cases';

/** 一题一轮的原始结果：只存评分需要的东西。 */
export interface EvalRun {
  id: string;
  round: number;
  text: string;
  calls: { name: string; args: string }[];
  ms: number;
  error?: string;
  dsml?: boolean;
}

export interface EvalVerdict {
  id: string;
  group: string;
  round: number;
  pass: boolean;
  reasons: string[];
}

function argsOf(call: { args: string }): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.args) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 给一次运行打分：所有期望都满足才算过；没过时写明原因。 */
export function scoreRun(spec: EvalCase, run: EvalRun): EvalVerdict {
  const reasons: string[] = [];
  const names = run.calls.map((call) => call.name);
  if (run.error) reasons.push(`请求失败：${run.error.slice(0, 80)}`);
  if (run.dsml) reasons.push('回复里漏了工具标记');
  if (spec.tool === null && names.length > 0) reasons.push(`不该调工具，却调了 ${names.join('+')}`);
  if (typeof spec.tool === 'string' && !names.includes(spec.tool)) {
    reasons.push(`该调 ${spec.tool}，实际 ${names.join('+') || '直接回答'}`);
  }
  if (Array.isArray(spec.tool) && !names.some((name) => spec.tool!.includes(name))) {
    reasons.push(`该调 ${spec.tool.join('/')} 之一，实际 ${names.join('+') || '直接回答'}`);
  }
  for (const name of spec.forbidTools ?? []) {
    if (names.includes(name)) reasons.push(`不该调 ${name}`);
  }
  const delegate = run.calls.find((call) => call.name === 'delegate_task');
  if (delegate && (spec.project !== undefined || spec.target !== undefined)) {
    const args = argsOf(delegate);
    if (spec.project !== undefined && args['project'] !== spec.project) {
      reasons.push(`项目该是 ${spec.project}，实际 ${String(args['project'] ?? '空')}`);
    }
    if (spec.target !== undefined && args['target'] !== spec.target) {
      reasons.push(`目标该是 ${spec.target}，实际 ${String(args['target'] ?? '空')}`);
    }
  }
  // 说没说：回复正文和工具参数都算——讲故事时把名字填进工具参数也是记得。
  const said = [run.text, ...run.calls.map((call) => call.args)].join('\n');
  if (spec.mustSay !== undefined && !said.includes(spec.mustSay))
    reasons.push(`没提到「${spec.mustSay}」`);
  if (spec.mustNotSay !== undefined && said.includes(spec.mustNotSay)) {
    reasons.push(`不该提到「${spec.mustNotSay}」`);
  }
  return { id: spec.id, group: spec.group, round: run.round, pass: reasons.length === 0, reasons };
}

export interface GroupScore {
  group: string;
  passed: number;
  total: number;
}

export interface EvalSummary {
  at: number;
  model: string;
  rounds: number;
  passed: number;
  total: number;
  groups: GroupScore[];
  /** 每题的通过轮数，用来和上次逐题对比。 */
  cases: Record<string, { passed: number; total: number; reasons: string[] }>;
  medianMs: number;
}

export function summarize(
  verdicts: readonly EvalVerdict[],
  runs: readonly EvalRun[],
  meta: { at: number; model: string; rounds: number },
): EvalSummary {
  const groups = new Map<string, GroupScore>();
  const cases: EvalSummary['cases'] = {};
  for (const verdict of verdicts) {
    const group = groups.get(verdict.group) ?? { group: verdict.group, passed: 0, total: 0 };
    group.total += 1;
    if (verdict.pass) group.passed += 1;
    groups.set(verdict.group, group);
    const item = cases[verdict.id] ?? { passed: 0, total: 0, reasons: [] };
    item.total += 1;
    if (verdict.pass) item.passed += 1;
    for (const reason of verdict.reasons)
      if (!item.reasons.includes(reason)) item.reasons.push(reason);
    cases[verdict.id] = item;
  }
  const times = runs.map((run) => run.ms).sort((a, b) => a - b);
  return {
    ...meta,
    passed: verdicts.filter((verdict) => verdict.pass).length,
    total: verdicts.length,
    groups: [...groups.values()],
    cases,
    medianMs: times.length === 0 ? 0 : times[Math.floor(times.length / 2)]!,
  };
}

const pct = (passed: number, total: number): string =>
  total === 0 ? '—' : `${Math.round((passed / total) * 100)}%`;

/** 分数表（Markdown）：分组通过率、和上次比的变化、退步与进步的题。 */
export function report(current: EvalSummary, previous: EvalSummary | null): string {
  const lines: string[] = [];
  lines.push(
    `# 芯伴评测 ${new Date(current.at).toLocaleString()}`,
    '',
    `模型 ${current.model} · 每题 ${current.rounds} 轮 · 中位耗时 ${(current.medianMs / 1000).toFixed(1)}s`,
    '',
    `**总分 ${current.passed}/${current.total}（${pct(current.passed, current.total)}）**` +
      (previous
        ? `，上次 ${previous.passed}/${previous.total}（${pct(previous.passed, previous.total)}）`
        : ''),
    '',
    '| 分组 | 本次 | 上次 |',
    '| --- | --- | --- |',
  );
  for (const group of current.groups) {
    const before = previous?.groups.find((item) => item.group === group.group);
    lines.push(
      `| ${group.group} | ${group.passed}/${group.total} ${pct(group.passed, group.total)} | ${
        before ? `${before.passed}/${before.total} ${pct(before.passed, before.total)}` : '—'
      } |`,
    );
  }
  const rate = (item?: { passed: number; total: number }) =>
    item && item.total > 0 ? item.passed / item.total : null;
  const worse: string[] = [];
  const better: string[] = [];
  for (const [id, item] of Object.entries(current.cases)) {
    const now = rate(item)!;
    const before = rate(previous?.cases[id]);
    if (before === null) continue;
    if (now < before) worse.push(`- ${id}：${item.reasons.join('；')}`);
    if (now > before) better.push(`- ${id}`);
  }
  const failing = Object.entries(current.cases)
    .filter(([, item]) => item.passed < item.total)
    .map(([id, item]) => `- ${id}（${item.passed}/${item.total}）：${item.reasons.join('；')}`);
  if (worse.length > 0) lines.push('', '## 比上次退步', ...worse);
  if (better.length > 0) lines.push('', '## 比上次进步', ...better);
  if (failing.length > 0) lines.push('', '## 没过的题', ...failing);
  return `${lines.join('\n')}\n`;
}
