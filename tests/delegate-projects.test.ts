import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultDelegate, delegatePrompt, normalizeDelegate } from '../src/core/delegate';
import {
  defaultProjectsRoot,
  findProject,
  isProjectDir,
  normalizeRoot,
  rootProblem,
} from '../src/core/projects';
import {
  DelegateService,
  DelegateStore,
  spawnRunner,
  type RunOptions,
  type RunResult,
} from '../src/desktop/delegate';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    // 派活记录是异步落盘的：目录可能还在被写，删不掉就重试。
    directories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      ),
  );
});

async function temp(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'xinban-projects-'));
  directories.push(directory);
  return directory;
}

const ok: RunResult = { code: 0, stdout: '改完了', stderr: '', timedOut: false, spawnError: '' };

function recorder(answer: (options: RunOptions) => RunResult | Promise<RunResult> = () => ok) {
  const runs: RunOptions[] = [];
  return {
    runs,
    runner: async (options: RunOptions): Promise<RunResult> => {
      runs.push(options);
      if (options.command === 'where' || options.command === 'which') {
        const bin = options.args[0] ?? '';
        return { ...ok, stdout: `C:\\npm\\${bin}.cmd\r\n` };
      }
      return answer(options);
    },
  };
}

/** 一个已授权、登记了根目录的服务。 */
async function service(
  root: string,
  runner: (options: RunOptions) => Promise<RunResult>,
  extra: Partial<typeof defaultDelegate> = {},
) {
  const dir = await temp();
  const store = new DelegateStore(join(dir, 'delegate-v1.json'));
  await store.save({
    ...defaultDelegate,
    allowAgents: true,
    target: 'claude',
    customArgs: [],
    projectsRoot: root,
    ...extra,
  });
  const history = join(dir, 'history.json');
  const delegate = new DelegateService(store, join(dir, 'workspace'), runner, history);
  await delegate.init();
  return { delegate, history, store };
}

describe('我的项目：纯规则', () => {
  it('根目录校验与归一化', () => {
    expect(rootProblem('')).toBe('');
    expect(rootProblem('D:\\claude-workspace')).toBe('');
    expect(rootProblem('claude-workspace')).toContain('完整路径');
    expect(rootProblem('D:\\a|b')).not.toBe('');
    expect(normalizeRoot(undefined)).toBe(defaultProjectsRoot);
    expect(normalizeRoot('relative')).toBe(defaultProjectsRoot);
    expect(normalizeRoot('D:\\work\\')).toBe('D:\\work');
    expect(normalizeRoot('D:\\')).toBe('D:\\');
    expect(normalizeRoot('')).toBe('');
    // 老配置没有这个字段：用用户定的默认根目录。
    expect(normalizeDelegate({}).projectsRoot).toBe('D:\\claude-workspace');
  });

  it('哪些文件夹算项目', () => {
    for (const name of ['ai-chat-web', 'warm-flow', '反向逃脱-(4.3)']) {
      expect(isProjectDir(name)).toBe(true);
    }
    for (const name of ['.claude', '.git', '_cli-anything-tmp', 'node_modules', '$RECYCLE.BIN']) {
      expect(isProjectDir(name)).toBe(false);
    }
  });

  it('项目名匹配：精确、忽略大小写与连字符；不做模糊包含', () => {
    const list = [
      { name: 'goods-match', path: 'D:\\w\\goods-match' },
      { name: 'goods-dq', path: 'D:\\w\\goods-dq' },
      { name: 'warm-flow', path: 'D:\\w\\warm-flow' },
    ];
    expect(findProject(list, 'Goods-Match')?.name).toBe('goods-match');
    expect(findProject(list, 'goods match')?.name).toBe('goods-match');
    expect(findProject(list, 'warmflow')?.name).toBe('warm-flow');
    expect(findProject(list, 'goods')).toBeUndefined();
    expect(findProject(list, '..\\..\\Windows')).toBeUndefined();
    expect(findProject(list, '')).toBeUndefined();
  });

  it('提示词列出项目，并要求点名就直接派', () => {
    const config = { ...defaultDelegate, allowAgents: true, target: 'claude' as const };
    const prompt = delegatePrompt(
      config,
      [{ id: 'claude', label: 'Claude Code', available: true, path: 'x' }],
      [{ name: 'warm-flow', path: 'D:\\claude-workspace\\warm-flow' }],
    );
    expect(prompt).toContain('warm-flow');
    expect(prompt).toContain('project');
    expect(prompt).toContain('第一步就调 delegate_task');
    // 没授权外包时不列项目。
    expect(
      delegatePrompt(
        { ...config, allowAgents: false, allowShell: true },
        [],
        [{ name: 'warm-flow', path: 'x' }],
      ),
    ).not.toContain('warm-flow');
  });
});

describe('我的项目：派活', () => {
  it('扫出根目录下的子文件夹，跳过隐藏/临时/文件', async () => {
    const root = await temp();
    for (const name of ['shop', 'blog', '.git', '_tmp', 'node_modules']) {
      await mkdir(join(root, name));
    }
    await writeFile(join(root, 'notes.txt'), 'x');
    const { delegate } = await service(root, recorder().runner);
    expect(delegate.snapshot().projects.map((item) => item.name)).toEqual(['blog', 'shop']);
    expect(delegate.snapshot().projectsError).toBe('');
  });

  it('指定项目 → 在那个文件夹里干；不指定 → 芯伴自己的工作目录', async () => {
    const root = await temp();
    await mkdir(join(root, 'shop'));
    const { runs, runner } = recorder();
    const { delegate } = await service(root, runner);
    const result = await delegate.run(
      { task: '修登录页', target: 'claude', project: 'SHOP' },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ ok: true });
    const job = runs.filter((item) => item.command !== 'where' && item.command !== 'which');
    expect(job[0]?.cwd).toBe(join(root, 'shop'));
    expect(job[0]?.stdin).toBe('修登录页');
    await delegate.run({ task: '再来一个' }, new AbortController().signal);
    const second = runs.filter((item) => item.command !== 'where' && item.command !== 'which');
    expect(second[1]?.cwd).not.toBe(join(root, 'shop'));
  });

  it('新建的文件夹不用重启就能派；对不上的项目名说清楚有哪些、不跑', async () => {
    const root = await temp();
    await mkdir(join(root, 'shop'));
    const { runs, runner } = recorder();
    const { delegate } = await service(root, runner);
    await mkdir(join(root, 'blog'));
    expect(
      await delegate.run({ task: 'x', project: 'blog' }, new AbortController().signal),
    ).toMatchObject({ ok: true });
    const before = runs.length;
    const missing = await delegate.run(
      { task: 'x', project: '..\\..\\Windows' },
      new AbortController().signal,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error).toContain('没有叫');
      expect(missing.error).toContain('shop');
    }
    expect(runs.slice(before).some((item) => item.command !== 'where')).toBe(false);
  });

  it('根目录不存在：面板上说找不到；保存时填错的根目录被退回', async () => {
    const root = join(await temp(), 'nope');
    const { delegate } = await service(root, recorder().runner);
    expect(delegate.snapshot().projectsError).toContain('找不到');
    const saved = await delegate.save({
      allowAgents: true,
      allowShell: false,
      target: 'claude',
      customBin: '',
      customArgs: [],
      projectsRoot: 'relative\\path',
    });
    expect(saved.ok).toBe(false);
    expect(saved.error).toContain('完整路径');
  });

  it('派活记录：成功/失败/超时都记，落盘，重启后还在', async () => {
    const root = await temp();
    await mkdir(join(root, 'shop'));
    let reply: RunResult = ok;
    const { runner } = recorder(() => reply);
    const { delegate, history, store } = await service(root, runner);
    await delegate.run({ task: '第一件', project: 'shop' }, new AbortController().signal);
    reply = { ...ok, code: 2, stdout: '', stderr: 'boom' };
    await delegate.run({ task: '第二件' }, new AbortController().signal);
    reply = { ...ok, timedOut: true, code: null };
    await delegate.run({ task: '第三件' }, new AbortController().signal);

    const items = delegate.snapshot().history;
    expect(items.map((item) => [item.task, item.outcome, item.project])).toEqual([
      ['第三件', 'timeout', ''],
      ['第二件', 'failed', ''],
      ['第一件', 'ok', 'shop'],
    ]);
    expect(items[1]).toMatchObject({ code: 2, target: 'Claude Code' });
    expect(items[1]!.error).not.toBe('');

    await delegate.flushHistory();
    expect(JSON.parse(await readFile(history, 'utf8')).items).toHaveLength(3);
    const again = new DelegateService(store, root, runner, history);
    await again.init();
    expect(again.snapshot().history).toHaveLength(3);
  });

  it('成功时只交回 stdout：Codex 打在 stderr 的横幅与回显不混进结论', async () => {
    const root = await temp();
    const { runner } = recorder(() => ({
      ...ok,
      stdout: '目录是 D:\\claude-workspace\\plans。\n',
      stderr: 'OpenAI Codex v0.123.0\n--------\nuser\n只读，不要…\ntokens used\n2,233\n',
    }));
    const { delegate } = await service(root, runner);
    const result = await delegate.run(
      { task: '只读', target: 'codex' },
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain('plans');
      expect(result.text).not.toContain('tokens used');
      expect(result.text).not.toContain('OpenAI Codex');
    }
    // stdout 是空的就退回 stderr（有的 CLI 只往 stderr 写）。
    const { runner: quiet } = recorder(() => ({ ...ok, stdout: '', stderr: '干完了' }));
    const { delegate: other } = await service(root, quiet);
    expect(await other.run({ task: 'x' }, new AbortController().signal)).toMatchObject({
      ok: true,
      text: '干完了',
    });
  });

  it('开工前已经取消：不起进程、不占坑', async () => {
    const root = await temp();
    const { runs, runner } = recorder();
    const { delegate } = await service(root, runner);
    const controller = new AbortController();
    controller.abort();
    const result = await delegate.run({ task: '干活' }, controller.signal);
    expect(result).toMatchObject({ ok: false });
    expect(runs.some((item) => item.command !== 'where' && item.command !== 'which')).toBe(false);
    expect(delegate.snapshot().busy).toBe(false);
    // 真执行器同样：取消的信号不起进程。
    const raw = await spawnRunner({
      command: process.execPath,
      args: ['-e', 'require("fs").writeFileSync("spawned.txt","1")'],
      cwd: root,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    expect(raw.spawnError).not.toBe('');
  });

  it.runIf(process.platform === 'win32')(
    '自定义批处理把任务拼进参数：拒绝，只让它走 stdin',
    async () => {
      const root = await temp();
      const { runs, runner } = recorder();
      const { delegate } = await service(root, runner, {
        target: 'custom',
        customBin: 'C:\\tools\\agent.cmd',
        customArgs: ['--task', '{task}'],
      });
      const result = await delegate.run({ task: 'a" & calc & "' }, new AbortController().signal);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('{task}');
      expect(runs.some((item) => item.command.endsWith('agent.cmd'))).toBe(false);
    },
  );
});
