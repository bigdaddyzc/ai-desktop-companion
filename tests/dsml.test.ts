import { describe, expect, it } from 'vitest';
import { dsmlDeltaFilter, hasDsml, recoverDsmlCalls, visibleText } from '../src/core/dsml';
import { historyItems } from '../src/core/responses';

const tools = ['delegate_task', 'web_search'];

/** 用户截到的原样：竖线两层、`calls` 不是 `function_calls`。 */
const userSample = [
  '我让 Claude 去重写。',
  '<｜｜DSML｜｜ calls>',
  '<｜｜DSML｜｜ invoke name="delegate_task">',
  '<｜｜DSML｜｜ parameter name="target" string="true">claude</｜｜DSML｜｜ parameter>',
  '<｜｜DSML｜｜ parameter name="task" string="true">读 research/派活素材-已知事实.md，据此重写 research/两个开源项目分析.md。</｜｜DSML｜｜ parameter>',
  '</｜｜DSML｜｜ invoke>',
  '</｜｜DSML｜｜ calls>',
].join('\n');

/** 官方格式。 */
const official = [
  '<｜DSML｜function_calls>',
  '<｜DSML｜invoke name="web_search">',
  '<｜DSML｜parameter name="query" string="true">长沙天气</｜DSML｜parameter>',
  '<｜DSML｜parameter name="limit" string="false">3</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜function_calls>',
].join('\n');

describe('识别漏出的工具标记', () => {
  it('官方格式、写坏的格式、半角竖线都认得', () => {
    expect(hasDsml(official)).toBe(true);
    expect(hasDsml(userSample)).toBe(true);
    expect(hasDsml('<|DSML|invoke name="x">')).toBe(true);
    expect(hasDsml('正常回答，里面有 a < b 和 <div>')).toBe(false);
  });

  it('标记前的话留下，标记一个字都不留', () => {
    expect(visibleText(userSample)).toBe('我让 Claude 去重写。');
    expect(visibleText(official)).toBe('');
    expect(visibleText('普通回答')).toBe('普通回答');
  });
});

describe('从标记里救回调用', () => {
  it('用户截到的那段：读出 delegate_task 和两个参数', () => {
    const { calls, broken } = recoverDsmlCalls(userSample, tools);
    expect(broken).toBe(false);
    expect(calls).toEqual([
      {
        name: 'delegate_task',
        arguments: JSON.stringify({
          target: 'claude',
          task: '读 research/派活素材-已知事实.md，据此重写 research/两个开源项目分析.md。',
        }),
      },
    ]);
  });

  it('string="false" 的参数按 JSON 读', () => {
    const { calls } = recoverDsmlCalls(official, tools);
    expect(JSON.parse(calls[0]!.arguments)).toEqual({ query: '长沙天气', limit: 3 });
  });

  it('参数没闭合（被截断）就整批不执行：半截的任务不能派出去', () => {
    const cut = userSample.slice(0, userSample.indexOf('据此重写'));
    expect(recoverDsmlCalls(cut, tools)).toEqual({ calls: [], broken: true });
  });

  it('没声明过的工具不执行', () => {
    expect(recoverDsmlCalls(userSample, ['web_search']).broken).toBe(true);
  });

  it('只有外壳没有 invoke 也算坏的', () => {
    expect(recoverDsmlCalls('<｜DSML｜function_calls>', tools).broken).toBe(true);
  });
});

describe('历史里的标记', () => {
  it('它自己以前漏出的标记不再发回给模型，免得它照着学', () => {
    expect(
      historyItems([
        { role: 'user', content: '帮我派个活' },
        { role: 'assistant', content: userSample },
        { role: 'user', content: '怎么样了' },
        { role: 'assistant', content: official },
      ]),
    ).toEqual([
      { role: 'user', content: '帮我派个活' },
      { role: 'assistant', content: '我让 Claude 去重写。' },
      { role: 'user', content: '怎么样了' },
    ]);
  });
});

describe('打字时过滤', () => {
  function run(chunks: string[]): string {
    const out: string[] = [];
    const filter = dsmlDeltaFilter((text) => out.push(text));
    for (const chunk of chunks) filter.push(chunk);
    filter.flush();
    return out.join('');
  }

  it('标记切在两块之间也拦得住', () => {
    expect(run(['我让 Claude 去重写。\n<', '｜｜DS', 'ML｜｜ calls>\n<｜｜DSML｜｜ invoke'])).toBe(
      '我让 Claude 去重写。',
    );
  });

  it('普通的小于号和标签最后都会送出去', () => {
    expect(run(['a <', ' b，用 <div', '> 包一下 <'])).toBe('a < b，用 <div> 包一下 <');
  });

  it('全是标记时什么也不显示', () => {
    expect(run([official.slice(0, 10), official.slice(10)])).toBe('');
  });
});
