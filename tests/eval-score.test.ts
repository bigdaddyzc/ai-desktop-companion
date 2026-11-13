import { describe, expect, it } from 'vitest';
import { evalCases, fixtureProjects } from '../scripts/eval/cases';
import { report, scoreRun, summarize, type EvalRun } from '../scripts/eval/score';

const run = (id: string, patch: Partial<EvalRun> = {}): EvalRun => ({
  id,
  round: 0,
  text: '',
  calls: [],
  ms: 1000,
  ...patch,
});
const spec = (id: string) => evalCases.find((item) => item.id === id)!;

describe('评测题库', () => {
  it('至少 40 题，题号不重复，派活题的项目都在合成项目里', () => {
    expect(evalCases.length).toBeGreaterThanOrEqual(40);
    expect(new Set(evalCases.map((item) => item.id)).size).toBe(evalCases.length);
    for (const item of evalCases) {
      if (item.project) expect(fixtureProjects).toContain(item.project);
    }
  });
});

describe('评分', () => {
  it('派活：工具、项目、目标都对才算过', () => {
    const good = run('dg-claude', {
      calls: [
        { name: 'delegate_task', args: '{"project":"warm-flow","target":"claude","task":"x"}' },
      ],
    });
    expect(scoreRun(spec('dg-claude'), good).pass).toBe(true);
    const wrongProject = run('dg-claude', {
      calls: [{ name: 'delegate_task', args: '{"project":"goods-match","target":"claude"}' }],
    });
    const verdict = scoreRun(spec('dg-claude'), wrongProject);
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons.join()).toContain('warm-flow');
    expect(scoreRun(spec('dg-claude'), run('dg-claude', { text: '好的' })).pass).toBe(false);
  });

  it('不该调工具 / 禁用工具 / 必须提到 / 不该提到 / 工具标记泄漏', () => {
    expect(scoreRun(spec('chat-hi'), run('chat-hi', { text: '嗨' })).pass).toBe(true);
    expect(
      scoreRun(spec('chat-hi'), run('chat-hi', { calls: [{ name: 'web_search', args: '{}' }] }))
        .pass,
    ).toBe(false);
    expect(
      scoreRun(spec('safe-rm'), run('safe-rm', { calls: [{ name: 'shell_command', args: '{}' }] }))
        .pass,
    ).toBe(false);
    expect(scoreRun(spec('mem-daughter'), run('mem-daughter', { text: '叫小满' })).pass).toBe(true);
    expect(scoreRun(spec('mem-daughter'), run('mem-daughter', { text: '不知道' })).pass).toBe(
      false,
    );
    expect(scoreRun(spec('mem-precision'), run('mem-precision', { text: '镜架怎样了' })).pass).toBe(
      false,
    );
    expect(scoreRun(spec('chat-hi'), run('chat-hi', { text: '嗨', dsml: true })).pass).toBe(false);
    expect(
      scoreRun(spec('comp-music'), run('comp-music', { calls: [{ name: 'music', args: '{}' }] }))
        .pass,
    ).toBe(true);
  });

  it('分数表：分组通过率，和上次比出进步与退步', () => {
    const runsA = [run('chat-hi', { text: '嗨' }), run('mem-daughter', { text: '小满' })];
    const runsB = [
      run('chat-hi', { calls: [{ name: 'look', args: '{}' }] }),
      run('mem-daughter', { text: '小满' }),
    ];
    const score = (runs: EvalRun[], at: number) =>
      summarize(
        runs.map((item) => scoreRun(spec(item.id), item)),
        runs,
        { at, model: 'm', rounds: 1 },
      );
    const before = score(runsA, 1);
    const after = score(runsB, 2);
    expect(before.passed).toBe(2);
    expect(after.passed).toBe(1);
    const text = report(after, before);
    expect(text).toContain('总分 1/2');
    expect(text).toContain('上次 2/2');
    expect(text).toContain('## 比上次退步');
    expect(text).toContain('chat-hi');
  });
});
