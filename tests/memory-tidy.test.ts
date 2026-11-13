import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  emptyMemory,
  extractionInput,
  type MemoryFact,
  type MemoryState,
} from '../src/core/memory';
import {
  applyTidyPlan,
  parseTidyPlan,
  shouldSuggestTidy,
  tidyAfterCount,
  tidyInput,
} from '../src/core/memory-tidy';
import { MemoryService, MemoryStore } from '../src/desktop/memory';
import { MemoryTidyService, type TidyModel } from '../src/desktop/memory-tidy';

const now = 1_770_000_000_000;

function fact(id: string, text: string, extra: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id,
    text,
    category: 'habit',
    source: 'inferred',
    createdAt: now - 1_000,
    updatedAt: now - 1_000,
    hits: 0,
    pinned: false,
    ...extra,
  };
}

function memoryOf(facts: MemoryFact[]): MemoryState {
  return { ...emptyMemory(), facts };
}

const sample = memoryOf([
  fact('a', '做事较真，不肯将就', { hits: 2 }),
  fact('b', '做事不肯将就，爱较真', { source: 'said' }),
  fact('c', '在查76价格未生效的问题', { category: 'goal' }),
  fact('d', '用户常年熬夜', { category: 'habit' }),
  fact('e', '有个女儿', { category: 'relation', pinned: true }),
  fact('f', '在长沙生活', { category: 'identity' }),
]);

const goodPlan = JSON.stringify({
  actions: [
    {
      kind: 'merge',
      ids: [1, 2],
      text: '做事较真，不肯将就',
      category: 'habit',
      reason: '同一件事',
    },
    { kind: 'drop', ids: [3], reason: '项目进度，会过期' },
    { kind: 'rewrite', ids: ['#4'], text: '常年熬夜', category: 'habit', reason: '去掉转述壳' },
  ],
});

describe('整理方案解析', () => {
  it('给模型的是短编号，不是内部 id', () => {
    const input = tidyInput(sample);
    expect(input.split('\n')[0]).toBe('#1 [习惯] 做事较真，不肯将就');
    expect(input).not.toContain(' a ');
  });

  it('编号映回原记忆，并记下原文', () => {
    const plan = parseTidyPlan('```json\n' + goodPlan + '\n```', sample, now)!;
    expect(plan.actions.map((action) => action.kind)).toEqual(['merge', 'drop', 'rewrite']);
    expect(plan.actions[0]!.sources.map((source) => source.id)).toEqual(['a', 'b']);
    expect(plan.actions[1]!.sources[0]!.text).toBe('在查76价格未生效的问题');
    expect(tidyAfterCount(plan)).toBe(4);
    expect(tidyAfterCount(plan, ['t3'])).toBe(6);
  });

  it('越界编号、重复引用、单条合并、删置顶、敏感内容都拦掉，其余照用', () => {
    const raw = JSON.stringify({
      actions: [
        { kind: 'drop', ids: [99], reason: '越界' },
        { kind: 'merge', ids: [1], text: '只有一条', reason: '' },
        { kind: 'drop', ids: [5], reason: '置顶的不能删' },
        { kind: 'rewrite', ids: [6], text: '住在岳麓区某小区3栋', reason: '敏感' },
        { kind: 'drop', ids: [3], reason: '进度' },
        { kind: 'merge', ids: [3, 4], text: '重复引用 3', reason: '' },
        { kind: 'explode', ids: [2], reason: '未知动作' },
      ],
    });
    const plan = parseTidyPlan(raw, sample, now)!;
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.sources[0]!.id).toBe('c');
  });

  it('理由里的编号换成人话：面板上看不到编号', () => {
    const raw = '{"actions":[{"kind":"drop","ids":[3],"reason":"与更新的#4矛盾"}]}';
    expect(parseTidyPlan(raw, sample, now)!.actions[0]!.reason).toBe('与更新的另一条矛盾');
  });

  it('改写成一模一样的不算动作', () => {
    const raw =
      '{"actions":[{"kind":"rewrite","ids":[6],"text":"在长沙生活。","category":"identity"}]}';
    expect(parseTidyPlan(raw, sample, now)!.actions).toHaveLength(0);
  });

  it('不是 JSON 就返回 null，交给界面说「没看懂」', () => {
    expect(parseTidyPlan('好的，我来整理', sample, now)).toBeNull();
    expect(parseTidyPlan('{"foo":1}', sample, now)).toBeNull();
  });
});

describe('应用方案', () => {
  it('合并继承最早创建时间、累计命中、said 来源，排在原位', () => {
    const plan = parseTidyPlan(goodPlan, sample, now)!;
    const { state, applied, stale } = applyTidyPlan(sample, plan, ['t1', 't2', 't3'], now);
    expect(applied).toBe(3);
    expect(stale).toBe(0);
    expect(state.facts.map((item) => item.text)).toEqual([
      '做事较真，不肯将就',
      '常年熬夜',
      '有个女儿',
      '在长沙生活',
    ]);
    const merged = state.facts[0]!;
    expect(merged.id).not.toBe('a');
    expect(merged.hits).toBe(2);
    expect(merged.source).toBe('said');
    expect(merged.createdAt).toBe(now - 1_000);
    expect(state.facts[1]!.id).toBe('d');
  });

  it('只应用勾选的项', () => {
    const plan = parseTidyPlan(goodPlan, sample, now)!;
    const { state } = applyTidyPlan(sample, plan, ['t2'], now);
    expect(state.facts).toHaveLength(5);
    expect(state.facts.some((item) => item.id === 'c')).toBe(false);
  });

  it('出方案后被改过或删掉的记忆，对应动作作废', () => {
    const plan = parseTidyPlan(goodPlan, sample, now)!;
    const changed = memoryOf(
      sample.facts
        .filter((item) => item.id !== 'c')
        .map((item) => (item.id === 'b' ? { ...item, text: '后来改了' } : item)),
    );
    const { state, applied, stale } = applyTidyPlan(changed, plan, ['t1', 't2', 't3'], now);
    expect(applied).toBe(1);
    expect(stale).toBe(2);
    expect(state.facts.map((item) => item.text)).toContain('后来改了');
  });
});

describe('提醒整理', () => {
  const many = (count: number) =>
    memoryOf(Array.from({ length: count }, (_, index) => fact(`x${index}`, `事情${index}`)));
  it('从没整理过：攒到 30 条才提醒', () => {
    expect(shouldSuggestTidy(many(29))).toBe(false);
    expect(shouldSuggestTidy(many(30))).toBe(true);
  });
  it('整理过：比上次多 20 条才提醒；关了记忆不提醒', () => {
    expect(shouldSuggestTidy({ ...many(39), tidiedAt: now, tidiedCount: 20 })).toBe(false);
    expect(shouldSuggestTidy({ ...many(40), tidiedAt: now, tidiedCount: 20 })).toBe(true);
    expect(shouldSuggestTidy({ ...many(40), enabled: false })).toBe(false);
  });
});

describe('抽取时带上已经记得的', () => {
  it('有已知条目时附在记录后面，没有就原样', () => {
    expect(extractionInput('用户：嗨', [])).toBe('用户：嗨');
    expect(extractionInput('用户：嗨', ['常年熬夜'])).toBe('用户：嗨\n\n已经记得：\n- 常年熬夜');
  });
});

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

async function seeded(clock: { at: number }) {
  const directory = await mkdtemp(join(tmpdir(), 'xinban-tidy-'));
  directories.push(directory);
  const store = new MemoryStore(join(directory, 'memory-v1.json'));
  await store.save(sample);
  const memory = new MemoryService(store, () => clock.at);
  await memory.init();
  return { directory, memory };
}

function model(reply: Awaited<ReturnType<TidyModel['tidy']>>, seen: string[] = []): TidyModel {
  return {
    tidy: (input) => {
      seen.push(input);
      return Promise.resolve(reply);
    },
  };
}

describe('整理流程（真实文件）', () => {
  it('出方案 → 应用前备份 → 改完能撤销，整理后新记的保留', async () => {
    const clock = { at: now };
    const { directory, memory } = await seeded(clock);
    const seen: string[] = [];
    const tidy = new MemoryTidyService(
      memory,
      model({ ok: true, text: goodPlan }, seen),
      () => now,
    );
    await tidy.init();
    expect(tidy.snapshot().canUndo).toBe(false);

    const ready = await tidy.start();
    expect(seen[0]).toContain('#3 [在做的事] 在查76价格未生效的问题');
    expect(ready.phase).toBe('ready');
    // 只是出方案，记忆一条没动。
    expect(memory.snapshot().facts).toHaveLength(6);

    clock.at = now + 10;
    const done = await tidy.apply(['t1', 't2', 't3']);
    expect(done.phase).toBe('idle');
    expect(done.notice).toBe('整理好了：6 条 → 4 条。');
    expect(done.canUndo).toBe(true);
    expect(memory.snapshot().tidiedCount).toBe(4);
    expect(await readdir(join(directory, 'memory-backups'))).toEqual([`memory-${now + 10}.json`]);

    // 重新加载文件，确认整理结果真的落盘了。
    const reloaded = new MemoryService(new MemoryStore(join(directory, 'memory-v1.json')));
    await reloaded.init();
    expect(reloaded.snapshot().facts).toHaveLength(4);

    clock.at = now + 20;
    await memory.remember('不吃香菜', 'preference');
    const undone = await tidy.undo();
    expect(undone.notice).toBe('已撤销上次整理，现在 7 条。');
    expect(undone.canUndo).toBe(false);
    const texts = memory.snapshot().facts.map((item) => item.text);
    expect(texts.slice(0, 6)).toEqual(sample.facts.map((item) => item.text));
    expect(texts[6]).toBe('不吃香菜');
    expect(memory.snapshot().tidiedAt).toBeUndefined();
  });

  it('模型失败或乱答时不动记忆', async () => {
    const { memory } = await seeded({ at: now });
    const failing = new MemoryTidyService(memory, model({ ok: false, error: '请求超时' }));
    expect((await failing.start()).error).toBe('请求超时');
    const garbled = new MemoryTidyService(memory, model({ ok: true, text: '我觉得都挨好' }));
    expect((await garbled.start()).phase).toBe('failed');
    expect(memory.snapshot().facts).toHaveLength(6);
  });

  it('模型层直接抛异常：落到 failed，不卡在「正在通读」，且能再试', async () => {
    const { memory } = await seeded({ at: now });
    let calls = 0;
    const flaky = new MemoryTidyService(memory, {
      tidy: async () => {
        calls += 1;
        if (calls === 1) throw new Error('socket hang up');
        return { ok: true, text: '{"actions":[]}' };
      },
    });
    const failed = await flaky.start();
    expect(failed.phase).toBe('failed');
    expect(failed.error).toContain('socket hang up');
    expect((await flaky.start()).notice).toBe('看了一遍，没什么需要整理的。');
    expect(memory.snapshot().facts).toHaveLength(6);
  });

  it('没什么可整理、条数太少、一项都不勾，都不写文件', async () => {
    const { directory, memory } = await seeded({ at: now });
    const empty = new MemoryTidyService(memory, model({ ok: true, text: '{"actions":[]}' }));
    expect((await empty.start()).notice).toBe('看了一遍，没什么需要整理的。');

    const tidy = new MemoryTidyService(memory, model({ ok: true, text: goodPlan }));
    await tidy.start();
    expect((await tidy.apply([])).notice).toBe('一条都没勾，没有改动。');
    await expect(readdir(join(directory, 'memory-backups'))).rejects.toThrow();

    await memory.clear();
    await memory.remember('不吃香菜');
    const seen: string[] = [];
    const few = new MemoryTidyService(memory, model({ ok: true, text: goodPlan }, seen));
    expect((await few.start()).notice).toBe('才 1 条，不用整理。');
    expect(seen).toHaveLength(0);
  });

  it('清空记忆时把整理备份也删掉', async () => {
    const { directory, memory } = await seeded({ at: now });
    const tidy = new MemoryTidyService(memory, model({ ok: true, text: goodPlan }));
    await tidy.start();
    await tidy.apply(['t2']);
    expect(await readdir(join(directory, 'memory-backups'))).toHaveLength(1);
    await memory.clear();
    await expect(readdir(join(directory, 'memory-backups'))).rejects.toThrow();
    await tidy.refresh();
    expect(tidy.snapshot().canUndo).toBe(false);
  });

  it('备份只留最近 10 份', async () => {
    const clock = { at: now };
    const { directory, memory } = await seeded(clock);
    const store = new MemoryStore(join(directory, 'memory-v1.json'));
    for (let index = 0; index < 12; index += 1) {
      await store.backup(memory.snapshot(), now + index);
    }
    const names = await readdir(join(directory, 'memory-backups'));
    expect(names).toHaveLength(10);
    expect(names).not.toContain(`memory-${now}.json`);
    expect((await store.latestBackup())?.at).toBe(now + 11);
  });
});
