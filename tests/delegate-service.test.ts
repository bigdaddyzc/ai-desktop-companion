import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DelegateService,
  DelegateStore,
  cmdLineFor,
  cmdShimArgs,
  decodeOutput,
  spawnRunner,
} from '../src/desktop/delegate';
import { defaultDelegate } from '../src/core/delegate';
import type { RunOptions, RunResult } from '../src/desktop/delegate';

const directories: string[] = [];

async function tempPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'xinban-delegate-'));
  directories.push(directory);
  return join(directory, 'delegate-v1.json');
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

interface Recorder {
  runs: RunOptions[];
  runner: (options: RunOptions) => Promise<RunResult>;
}

/** 假执行器：`where` 一律成功，真正的派活按传入的回答返回。 */
function recorder(
  answer: (options: RunOptions) => RunResult | Promise<RunResult> = () => ({
    code: 0,
    stdout: '改完了，测试通过。',
    stderr: '',
    timedOut: false,
    spawnError: '',
  }),
): Recorder {
  const runs: RunOptions[] = [];
  return {
    runs,
    runner: async (options) => {
      runs.push(options);
      if (options.command === 'where') {
        const bin = options.args[0] ?? '';
        return {
          code: bin === 'codex' ? 1 : 0,
          stdout: bin === 'codex' ? '' : `C:\\npm\\${bin}.cmd\r\n`,
          stderr: '',
          timedOut: false,
          spawnError: '',
        };
      }
      return answer(options);
    },
  };
}

const signal = new AbortController().signal;

describe('DelegateStore', () => {
  it('没存过时两项都是关的', async () => {
    const store = new DelegateStore(await tempPath());
    expect(await store.load()).toMatchObject({ allowAgents: false, allowShell: false });
  });

  it('存下来的配置读得回来，字段写全', async () => {
    const path = await tempPath();
    const store = new DelegateStore(path);
    await store.save({
      ...defaultDelegate,
      allowAgents: true,
      allowShell: true,
      target: 'codex',
      customArgs: [],
    });
    const raw = JSON.parse(await readFile(path, 'utf8'));
    expect(raw).toMatchObject({ version: 1, allowAgents: true, allowShell: true, target: 'codex' });
    expect(await store.load()).toMatchObject({ allowAgents: true, target: 'codex' });
  });
});

describe('DelegateService 探测', () => {
  it('探测到哪里装了、哪里没装', async () => {
    const { runner } = recorder();
    const service = new DelegateService(new DelegateStore(await tempPath()), process.cwd(), runner);
    await service.init();
    const snapshot = service.snapshot();
    expect(snapshot.targets.find((item) => item.id === 'claude')).toMatchObject({
      available: true,
      path: 'C:\\npm\\claude.cmd',
    });
    expect(snapshot.targets.find((item) => item.id === 'codex')?.available).toBe(false);
    // 没授权时状态是 off，而不是 missing——两件事要分得清。
    expect(snapshot.status).toBe('off');
  });

  it('自定义命令没填时不探测，直接算不可用', async () => {
    const { runner, runs } = recorder();
    const service = new DelegateService(new DelegateStore(await tempPath()), process.cwd(), runner);
    await service.init();
    expect(service.snapshot().targets.find((item) => item.id === 'custom')?.available).toBe(false);
    expect(runs.filter((run) => run.command === 'where').length).toBe(2);
  });
});

describe('DelegateService 保存', () => {
  it('自定义目标没填命令时不保存', async () => {
    const { runner } = recorder();
    const service = new DelegateService(new DelegateStore(await tempPath()), process.cwd(), runner);
    await service.init();
    const result = await service.save({
      ...defaultDelegate,
      target: 'custom',
      customBin: 'claude && rm -rf /',
    });
    expect(result.ok).toBe(false);
    expect(result.error).not.toBe('');
  });

  it('保存成功后状态立刻变', async () => {
    const { runner } = recorder();
    const service = new DelegateService(new DelegateStore(await tempPath()), process.cwd(), runner);
    await service.init();
    expect(await service.save({ ...defaultDelegate, allowAgents: true })).toEqual({ ok: true });
    expect(service.snapshot().status).toBe('ready');
    expect(service.snapshot().config.allowAgents).toBe(true);
  });

  it('30/60/90/120 分钟都能保存、落盘、重载，校验层不把它们夹回 30', async () => {
    const path = await tempPath();
    const { runner } = recorder();
    const service = new DelegateService(new DelegateStore(path), process.cwd(), runner);
    await service.init();
    for (const minutes of [30, 60, 90, 120]) {
      expect(
        await service.save({ ...defaultDelegate, allowAgents: true, timeoutMinutes: minutes }),
      ).toEqual({ ok: true });
      expect(JSON.parse(await readFile(path, 'utf8')).timeoutMinutes).toBe(minutes);
      expect((await new DelegateStore(path).load()).timeoutMinutes).toBe(minutes);
    }
  });
});

describe('DelegateService 派活', () => {
  it('没授权就不跑，也不起进程', async () => {
    const { runner, runs } = recorder();
    const service = new DelegateService(new DelegateStore(await tempPath()), process.cwd(), runner);
    await service.init();
    const result = await service.run({ task: '改一下首页' }, signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('授权');
    expect(runs.filter((run) => run.command !== 'where')).toHaveLength(0);
  });

  it('任务走 stdin，命令行里不出现任务文本', async () => {
    const { runner, runs } = recorder();
    const service = new DelegateService(new DelegateStore(await tempPath()), process.cwd(), runner);
    await service.init();
    // 显式选 claude：这条测的是「预设目标怎么拼命令行」，不该跟着默认值漂。
    await service.save({ ...defaultDelegate, allowAgents: true, target: 'claude' });
    const result = await service.run({ task: '修一下登录按钮 & echo 危险' }, signal);
    expect(result.ok).toBe(true);
    const call = runs.find((run) => run.command !== 'where')!;
    expect(call.command).toBe('C:\\npm\\claude.cmd');
    expect(call.stdin).toBe('修一下登录按钮 & echo 危险');
    expect(call.args.join(' ')).not.toContain('修一下');
    expect(call.cwd).toBe(process.cwd());
  });

  it('WorkBuddy 用它自带的 CLI：node 跑入口，任务照样走 stdin', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xinban-wb-'));
    directories.push(directory);
    const cli = join(directory, 'codebuddy');
    await writeFile(cli, '// stub\n');
    const previous = process.env['XINBAN_WORKBUDDY_CLI'];
    process.env['XINBAN_WORKBUDDY_CLI'] = cli;
    try {
      const { runner, runs } = recorder();
      const service = new DelegateService(
        new DelegateStore(await tempPath()),
        process.cwd(),
        runner,
      );
      await service.init();
      await service.save({ ...defaultDelegate, allowAgents: true, target: 'workbuddy' });
      const result = await service.run({ task: '把 README 补一下' }, signal);
      expect(result.ok).toBe(true);
      const call = runs.find((run) => run.command !== 'where')!;
      // CLI 是 node 脚本，Windows 上不能直接执行：必须先过 node。
      expect(call.command).toBe('C:\\npm\\node.cmd');
      expect(call.args[0]).toBe(cli);
      expect(call.stdin).toBe('把 README 补一下');
      expect(call.args.join(' ')).not.toContain('README');
      if (result.ok) expect(result.target).toBe('WorkBuddy');
    } finally {
      if (previous === undefined) delete process.env['XINBAN_WORKBUDDY_CLI'];
      else process.env['XINBAN_WORKBUDDY_CLI'] = previous;
    }
  });

  it('一句话没说就退了：不当普通失败，提示去看真报错', async () => {
    const { runner } = recorder(() => ({
      code: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      spawnError: '',
    }));
    const service = new DelegateService(new DelegateStore(await tempPath()), process.cwd(), runner);
    await service.init();
    await service.save({ ...defaultDelegate, allowAgents: true, target: 'claude' });
    const result = await service.run({ task: '补测试' }, signal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('立刻退出');
      expect(result.error).toContain('安全策略');
    }
  });

  it('退出码 0 但没登录：当失败，并把登录这一步说清楚', async () => {
    const { runner } = recorder(() => ({
      code: 0,
      stdout: '',
      stderr: 'Authentication required. Please use /login command to sign in to your account',
      timedOut: false,
      spawnError: '',
    }));
    const service = new DelegateService(new DelegateStore(await tempPath()), process.cwd(), runner);
    await service.init();
    await service.save({
      ...defaultDelegate,
      allowAgents: true,
      target: 'claude',
      fallback: false,
    });
    const result = await service.run({ task: '补测试' }, signal);
    // 这条最容易骗人：退出码是 0，但活一个字没干。
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('登录');
      expect(result.error).toContain('claude');
    }
    expect(service.snapshot().lastError).toContain('登录');
  });

  it('成功时把输出交给模型，并记下任务', async () => {
    const { runner } = recorder(() => ({
      code: 0,
      stdout: '\u001b[32m改完了\u001b[0m\n结论：测试通过',
      stderr: '',
      timedOut: false,
      spawnError: '',
    }));
    const service = new DelegateService(new DelegateStore(await tempPath()), process.cwd(), runner);
    await service.init();
    await service.save({ ...defaultDelegate, allowAgents: true, target: 'claude' });
    const result = await service.run({ task: '补测试' }, signal);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain('结论：测试通过');
      expect(result.text).not.toContain('\u001b[');
      expect(result.target).toBe('Claude Code');
      expect(result.note).toContain('Claude Code');
    }
    expect(service.snapshot().lastTask).toBe('补测试');
    expect(service.snapshot().busy).toBe(false);
  });

  it('非零退出如实翻译，并把原因记进快照', async () => {
    const { runner } = recorder(() => ({
      code: 1,
      stdout: '',
      stderr: 'Error: not logged in',
      timedOut: false,
      spawnError: '',
    }));
    const service = new DelegateService(new DelegateStore(await tempPath()), process.cwd(), runner);
    await service.init();
    await service.save({ ...defaultDelegate, allowAgents: true });
    const result = await service.run({ task: '改首页' }, signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('登录');
    expect(service.snapshot().lastError).toContain('登录');
  });

  it('超时会把它停掉，说清等多久，并把做到哪交回来', async () => {
    const { runner, runs } = recorder(() => ({
      code: null,
      stdout: '读完了 3 个文件，正在跑测试…',
      stderr: '',
      timedOut: true,
      spawnError: '',
    }));
    const service = new DelegateService(new DelegateStore(await tempPath()), process.cwd(), runner);
    await service.init();
    await service.save({
      ...defaultDelegate,
      allowAgents: true,
      target: 'claude',
      timeoutMinutes: 20,
    });
    const result = await service.run({ task: '大工程' }, signal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 等了多久要按配置说，不能写死 120 秒。
      expect(result.error).toContain('20 分钟');
      // 长任务白等一场最气人：跑到哪了必须留下来。
      expect(result.error).toContain('正在跑测试');
      expect(result.error).toContain('不完整');
    }
    expect(runs.at(-1)?.timeoutMs).toBe(20 * 60_000);
  });

  it('老配置没写分钟数：默认 10 分钟，不是旧的 2 分钟', async () => {
    const path = await tempPath();
    await writeFile(
      path,
      JSON.stringify({ version: 1, allowAgents: true, allowShell: false, target: 'claude' }),
      'utf8',
    );
    const config = await new DelegateStore(path).load();
    expect(config.timeoutMinutes).toBe(10);
  });

  it('120 分钟：保存→落盘→重载→派活全程生效，超时没被夹回 30', async () => {
    const path = await tempPath();
    const { runner, runs } = recorder();
    const service = new DelegateService(new DelegateStore(path), process.cwd(), runner);
    await service.init();
    expect(
      await service.save({
        ...defaultDelegate,
        allowAgents: true,
        target: 'claude',
        timeoutMinutes: 120,
      }),
    ).toEqual({ ok: true });
    expect(JSON.parse(await readFile(path, 'utf8')).timeoutMinutes).toBe(120);
    expect((await new DelegateStore(path).load()).timeoutMinutes).toBe(120);
    await service.run({ task: '大工程' }, signal);
    expect(runs.at(-1)?.timeoutMs).toBe(120 * 60_000);
  });

  it('没装命令时不去跑，直接说没找到', async () => {
    const { runner, runs } = recorder();
    const service = new DelegateService(new DelegateStore(await tempPath()), process.cwd(), runner);
    await service.init();
    await service.save({ ...defaultDelegate, allowAgents: true, fallback: false });
    const result = await service.run({ task: '干活', target: 'codex' }, signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('没找到');
    expect(runs.filter((run) => run.command === 'C:\\npm\\codex.cmd')).toHaveLength(0);
  });

  it('一次只干一件', async () => {
    // 用一个队列接住 resolve：TS 会把只在回调里赋值的局部变量收窄成 never。
    const pending: ((result: RunResult) => void)[] = [];
    const { runner } = recorder(
      () =>
        new Promise<RunResult>((resolve) => {
          pending.push(resolve);
        }),
    );
    const service = new DelegateService(new DelegateStore(await tempPath()), process.cwd(), runner);
    await service.init();
    // 显式 claude：这条测的是并发闸门，不该顺带探测宿主机上装没装 WorkBuddy。
    await service.save({ ...defaultDelegate, allowAgents: true, target: 'claude' });
    const first = service.run({ task: '第一件' }, signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await service.run({ task: '第二件' }, signal);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain('还没干完');
    pending[0]?.({ code: 0, stdout: '好了', stderr: '', timedOut: false, spawnError: '' });
    await first;
  });
});

describe('cmdLineFor', () => {
  it('每个 token 都加引号，% 转义，引号翻倍', () => {
    expect(cmdLineFor('C:\\a b\\x.cmd', ['-p', 'a"b%PATH%'])).toBe(
      '"C:\\a b\\x.cmd" "-p" "a""b%%PATH%%"',
    );
  });

  it('交给 cmd 的整行外面再包一层引号（/s 会剥掉它）', () => {
    expect(cmdShimArgs('C:\\a b\\x.cmd', ['-p'])).toEqual([
      '/d',
      '/s',
      '/c',
      '""C:\\a b\\x.cmd" "-p""',
    ]);
  });

  it('cmd 的 GBK 报错解成中文，UTF-8 照常', () => {
    const gbk = Buffer.from([0xb2, 0xbb, 0xca, 0xc7, 0xc4, 0xda, 0xb2, 0xbf]); // 「不是内部」
    expect(decodeOutput(gbk)).toBe('不是内部');
    expect(decodeOutput(Buffer.from('改好了 OK', 'utf8'))).toBe('改好了 OK');
  });

  // 真起进程：Claude Code / Codex 都是 npm 装的 .cmd。以前 Node 把引号转成 \"，
  // cmd 报「不是内部或外部命令」退出码 1，派活全挂。路径带空格和中文更容易踩坑。
  it.runIf(process.platform === 'win32')(
    '真的能跑路径带空格与中文的 .cmd，参数与 stdin 都到位',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), '芯伴 cmd-'));
      directories.push(directory);
      const script = join(directory, 'fake agent.cmd');
      await writeFile(script, '@echo off\r\necho ARGS=%*\r\nmore\r\n');
      const result = await spawnRunner({
        command: script,
        args: ['-p', '--permission-mode', 'acceptEdits'],
        cwd: directory,
        stdin: 'hello-task',
        timeoutMs: 15_000,
      });
      expect(result.spawnError).toBe('');
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('ARGS="-p" "--permission-mode" "acceptEdits"');
      expect(result.stdout).toContain('hello-task');
    },
  );
});
