import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { writeJsonAtomic } from './atomic';
import { conclusionOf, testSummaryLines } from '../core/review';
import {
  customBinProblem,
  customTarget,
  defaultDelegate,
  autoOrder,
  delegateChain,
  delegateCommand,
  delegateCooldownMs,
  delegateEarlyFailMs,
  delegateErrorText,
  delegateUnavailable,
  delegateLimits,
  delegateOutput,
  delegateSilentExit,
  delegateTargets,
  delegateTimeoutMs,
  delegateUnauthenticated,
  delegateCrashed,
  delegateNoiseFree,
  isTargetId,
  normalizeDelegate,
  targetOf,
  taskProblem,
  taskWithFiles,
  fileDirArgs,
  type DelegateAvailability,
  type DelegateConfig,
  type DelegateRecord,
  type DelegateRunResult,
  type DelegateSnapshot,
  type DelegateTarget,
  type DelegateTargetId,
} from '../core/delegate';
import {
  findProject,
  isProjectDir,
  projectLimits,
  rootProblem,
  type ProjectEntry,
} from '../core/projects';

/**
 * 委派服务：把「一句话任务」交给本机的 AI Agent 命令行，等它干完。
 *
 * 这里只做四件事：存取配置、探测命令是否装了、起进程并喂 stdin、把输出收干净。
 * 决策（派给谁、什么时候派）在模型那边；边界（开关、超时、输出上限、单飞）在这里。
 *
 * 为什么任务走 stdin：命令行是 cmd.exe 解析的，任务文本里一个 `&` 或 `%PATH%`
 * 就能改变执行结果。stdin 没有这层解析，模型写什么原文就到什么。
 */

// 两份校验的分钟上限都从 delegateLimits.maxTimeoutMs 折算，和面板档位同源；
// 不再写死一个数字，免得档位扩到 120 了校验还卡在 30。
const storedSchema = z
  .object({
    version: z.literal(1),
    allowAgents: z.boolean().optional(),
    allowShell: z.boolean().optional(),
    target: z.string().max(20).optional(),
    fallback: z.boolean().optional(),
    customBin: z.string().max(delegateLimits.customBinChars).optional(),
    customArgs: z.array(z.string().max(delegateLimits.argChars)).max(10).optional(),
    timeoutMinutes: z
      .number()
      .int()
      .min(1)
      .max(delegateLimits.maxTimeoutMs / 60_000)
      .optional(),
    projectsRoot: z.string().max(projectLimits.rootChars).optional(),
  })
  .strict();

const saveSchema = z.object({
  allowAgents: z.boolean(),
  allowShell: z.boolean(),
  target: z.enum(['auto', 'workbuddy', 'claude', 'codex', 'custom']),
  fallback: z.boolean().optional(),
  customBin: z.string().max(delegateLimits.customBinChars * 4),
  customArgs: z.array(z.string().max(delegateLimits.argChars * 4)).max(20),
  // 可选：老版本前端没有这个字段，normalizeDelegate 会补成默认 10 分钟。
  timeoutMinutes: z
    .number()
    .int()
    .min(1)
    .max(delegateLimits.maxTimeoutMs / 60_000)
    .optional(),
  projectsRoot: z
    .string()
    .max(projectLimits.rootChars * 2)
    .optional(),
});

const historySchema = z.object({
  v: z.literal(1),
  items: z
    .array(
      z.object({
        at: z.number().finite(),
        target: z.string().max(80),
        project: z.string().max(projectLimits.nameChars),
        task: z.string().max(400),
        outcome: z.enum(['ok', 'failed', 'timeout', 'cancelled']),
        ms: z.number().finite().min(0),
        code: z.number().int().nullable(),
        error: z.string().max(400),
        cwd: z.string().max(1_000).optional(),
        summary: z.string().max(1_000).optional(),
        tests: z.array(z.string().max(200)).max(5).optional(),
        baseline: z.object({ head: z.string().max(64), dirty: z.number().int().min(0) }).optional(),
      }),
    )
    .max(100),
});

/**
 * WorkBuddy 自带 CLI 的位置。
 *
 * 它不是 PATH 里的命令，而是跟着 WorkBuddy 安装包贴在 resources/app.asar.unpacked/cli 下，
 * 所以只能按安装目录找。找到之后还要用 node 去跑（那一层是 .js/mjs 的入口，没有 .exe）。
 * 装到非默认盘（比如 E:\workbuddy）很常见，因此候选里也给了盘符无关的探测：
 * 用户可以在面板里用环境变量 XINBAN_WORKBUDDY_CLI 直接指定。
 */
function workbuddyCliCandidates(): string[] {
  const explicit = process.env['XINBAN_WORKBUDDY_CLI']?.trim();
  // 优先用「完整版」原生 CLI：随桌面版发布的那份只含 headless 产物，
  // 没有交互界面（dist 里只有 codebuddy-lite-wb.mjs），无法 /login 登录。
  // 完整版由官方 `codebuddy install` 装到 LOCALAPPDATA\codebuddy\bin。
  const native = join(process.env['LOCALAPPDATA'] ?? '', 'codebuddy', 'bin', 'codebuddy.exe');
  const roots = [
    process.env['WORKBUDDY_HOME'],
    join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'WorkBuddy'),
    join(process.env['PROGRAMFILES'] ?? '', 'WorkBuddy'),
    join(process.env['PROGRAMFILES(X86)'] ?? '', 'WorkBuddy'),
  ].filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  if (process.platform === 'win32') {
    // 装在非系统盘很常见（这台机器就在 E:\workbuddy），而安装目录不会写进 PATH，
    // 只能按常见的盘符 + 目录名试一遍。stat 一次很便宜。
    for (const drive of ['C:', 'D:', 'E:', 'F:']) {
      roots.push(`${drive}\\workbuddy`, `${drive}\\WorkBuddy`);
    }
  }
  const suffix = join('resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy');
  const list = [
    ...(explicit === undefined || explicit === '' ? [] : [explicit]),
    ...(process.platform === 'win32' ? [native] : []),
  ];
  for (const root of roots) list.push(join(root, suffix));
  return list;
}

export class DelegateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<DelegateConfig> {
    try {
      return normalizeDelegate(storedSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))));
    } catch {
      // 文件不存在、损坏、被手改：一律当「没授权」。默认值本身就是拒绝。
      return { ...defaultDelegate, customArgs: [] };
    }
  }

  async save(config: DelegateConfig): Promise<void> {
    await writeJsonAtomic(this.path, {
      version: 1,
      allowAgents: config.allowAgents,
      allowShell: config.allowShell,
      target: config.target,
      fallback: config.fallback,
      customBin: config.customBin,
      customArgs: config.customArgs,
      timeoutMinutes: delegateTimeoutMs(config.timeoutMinutes) / 60_000,
      projectsRoot: config.projectsRoot,
    });
  }
}

export interface RunOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  /** 写进子进程 stdin 的内容；undefined 表示不喂。 */
  stdin?: string;
  /** 叠加到继承环境上的变量：只放我们自己写死的值。 */
  env?: Readonly<Record<string, string>>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** 实时输出（stdout 与 stderr 都算），只用来显示进度；最终结果仍以 RunResult 为准。 */
  onOutput?: (chunk: string) => void;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 进程都没起来时的原因（找不到命令、权限不足），空串表示起来了。 */
  spawnError: string;
}

export type ProcessRunner = (options: RunOptions) => Promise<RunResult>;

/**
 * cmd.exe 的命令行拼装。
 *
 * 只有 .cmd/.bat 需要（CreateProcess 不能直接执行批处理）。每个 token 都加引号：
 * 引号内的 `&`、`|`、`>` 都是普通字符。`%` 在引号内仍会展开，所以转成 `%%`。
 * 这不是完备的转义，但配合「预设目标一律把任务放 stdin」，模型写的文字根本到不了这里。
 */
export function cmdLineFor(command: string, args: readonly string[]): string {
  const quote = (token: string): string => `"${token.replaceAll('%', '%%').replaceAll('"', '""')}"`;
  return [command, ...args].map(quote).join(' ');
}

/**
 * 交给 cmd.exe 的参数。必须配合 windowsVerbatimArguments 使用：
 * Node 默认会把参数里的引号转成 `\"`（C 运行库的规则），而 cmd 不认这种转义，
 * 会报「'\"C:\...\claude.cmd\"' 不是内部或外部命令」并以退出码 1 退出——
 * 派活给 Claude Code / Codex（都是 npm 装的 .cmd）就是这样全挂的。
 * 外层再包一对引号：/s 会恰好剥掉这一对，里面每个 token 的引号原样保留。
 */
export function cmdShimArgs(command: string, args: readonly string[]): string[] {
  return ['/d', '/s', '/c', `"${cmdLineFor(command, args)}"`];
}

/**
 * 子进程输出解码：先按 UTF-8，不合法再按 GBK。
 * cmd.exe 自己的报错走系统代码页（中文 Windows 是 936），按 UTF-8 解出来是一串乱码，
 * 用户在「对方说」里就看不到真正的原因。
 */
export function decodeOutput(bytes: Buffer): string {
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  // 输出到上限被截断时，末尾可能卡着半个字：让掉最多 3 字节再试，别因此整段错当 GBK。
  for (let drop = 0; drop <= 3 && drop < bytes.length; drop += 1) {
    try {
      return utf8.decode(bytes.subarray(0, bytes.length - drop));
    } catch {
      // 继续尝试
    }
  }
  try {
    return new TextDecoder('gbk').decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

/** 结束整棵进程树：只 kill 掉 cmd.exe，底下的 node 会变成孤儿继续跑。 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill('SIGKILL');
    return;
  }
  if (process.platform !== 'win32') {
    child.kill('SIGKILL');
    return;
  }
  try {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => child.kill('SIGKILL'));
  } catch {
    child.kill('SIGKILL');
  }
}

/** 真实执行器。测试里换成假的，不用真的起进程。 */
export const spawnRunner: ProcessRunner = (options) =>
  new Promise<RunResult>((resolve) => {
    // 已经取消了就别再起进程：听 abort 事件的钩子还没挂上，起了就停不下来。
    if (options.signal?.aborted) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: '已取消。' });
      return;
    }
    const useCmdShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(options.command);
    const command = useCmdShim ? (process.env['ComSpec'] ?? 'cmd.exe') : options.command;
    const args = useCmdShim ? cmdShimArgs(options.command, options.args) : [...options.args];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        // 只对 cmd.exe 原样传参；引号已由 cmdShimArgs 自己处理好。
        windowsVerbatimArguments: useCmdShim,
        env: { ...process.env, ...options.env, ELECTRON_RUN_AS_NODE: undefined },
        stdio: 'pipe',
      });
    } catch {
      resolve({
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnError: '无法启动进程。',
      });
      return;
    }

    // 先收字节、最后一次解码：多字节字符可能被切在两个 chunk 之间。
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    const cap = delegateLimits.maxOutput * 9;
    const text = (chunks: Buffer[]): string => decodeOutput(Buffer.concat(chunks));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs);
    const onAbort = (): void => killTree(child);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const live = (chunk: Buffer): void => {
      if (!options.onOutput) return;
      try {
        options.onOutput(chunk.toString('utf8'));
      } catch {
        // 进度显示出错不影响干活。
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      live(chunk);
      if (outBytes < cap) {
        out.push(chunk);
        outBytes += chunk.length;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      live(chunk);
      if (errBytes < cap) {
        err.push(chunk);
        errBytes += chunk.length;
      }
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        code: null,
        stdout: text(out),
        stderr: text(err),
        timedOut: false,
        spawnError: /ENOENT/i.test(error.message) ? '找不到这个命令。' : '无法启动命令。',
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout: text(out), stderr: text(err), timedOut, spawnError: '' });
    });

    // stdin 一定要显式 end：两个 CLI 都在等「输入结束」才开工。
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });

export class DelegateService {
  private config: DelegateConfig = { ...defaultDelegate, customArgs: [] };
  private availability: DelegateAvailability[] = [];
  private busy = false;
  private lastTask = '';
  private lastAt = 0;
  private lastError = '';
  private projects: ProjectEntry[] = [];
  private projectsError = '';
  private history: DelegateRecord[] = [];
  private current: DelegateSnapshot['current'] = null;
  /** 最近一次「用不了」的时刻：自动挑时把它们排到后面。只在内存里。 */
  private readonly unavailableAt = new Map<DelegateTargetId, number>();
  private historyWrite: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(snapshot: DelegateSnapshot) => void>();

  constructor(
    private readonly store: DelegateStore,
    private readonly workspaceRoot: string,
    private readonly runner: ProcessRunner = spawnRunner,
    /** 派活记录落盘位置；不给就只在内存里（单测）。 */
    private readonly historyPath?: string,
    /** 开工前记一下工作区（只读 git）；不给就不记（单测）。 */
    private readonly baselineOf?: (cwd: string) => Promise<DelegateRecord['baseline'] | null>,
  ) {}

  async init(): Promise<void> {
    this.config = await this.store.load();
    await this.loadHistory();
    await this.probe();
  }

  private async loadHistory(): Promise<void> {
    if (this.historyPath === undefined) return;
    try {
      const parsed = historySchema.safeParse(JSON.parse(await readFile(this.historyPath, 'utf8')));
      if (parsed.success) this.history = parsed.data.items.slice(0, delegateLimits.history);
    } catch {
      // 没有或坏了：从空记录开始。
    }
  }

  private record(entry: DelegateRecord): void {
    this.history = [entry, ...this.history].slice(0, delegateLimits.history);
    const path = this.historyPath;
    if (path === undefined) return;
    // 排队写：两次写并发时 rename 的先后不定，旧列表可能盖掉新列表。
    const items = this.history;
    this.historyWrite = this.historyWrite
      .then(() => writeJsonAtomic(path, { v: 1, items }))
      .catch(() => undefined);
  }

  /** 等派活记录写完（退出前、测试里用）。 */
  flushHistory(): Promise<void> {
    return this.historyWrite;
  }

  /**
   * 扫登记根目录下的一级子文件夹。只列目录名，不读里面的东西。
   * 符号链接 / junction 不算：那会把「根目录下的项目」指到别处去。
   */
  private async scanProjects(): Promise<void> {
    const root = this.config.projectsRoot;
    if (root === '') {
      this.projects = [];
      this.projectsError = '';
      return;
    }
    try {
      const entries = await readdir(root, { withFileTypes: true });
      this.projects = entries
        .filter((entry) => entry.isDirectory() && isProjectDir(entry.name))
        .map((entry) => ({ name: entry.name, path: join(root, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
        .slice(0, projectLimits.maxProjects);
      this.projectsError = '';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      this.projects = [];
      this.projectsError =
        code === 'ENOENT' ? `找不到 ${root}。` : `读不了 ${root}${code ? `（${code}）` : ''}。`;
    }
  }

  snapshot(): DelegateSnapshot {
    const wanted = this.config.target;
    const ready = this.availability.some(
      (item) =>
        item.available && (wanted === 'auto' ? autoOrder.includes(item.id) : item.id === wanted),
    );
    const status: DelegateSnapshot['status'] = !this.config.allowAgents
      ? 'off'
      : ready
        ? 'ready'
        : 'missing';
    return {
      config: { ...this.config, customArgs: [...this.config.customArgs] },
      targets: this.availability.map((item) => ({ ...item })),
      status,
      busy: this.busy,
      lastTask: this.lastTask,
      lastAt: this.lastAt,
      lastError: this.lastError,
      projects: this.projects.map((item) => ({ ...item })),
      projectsError: this.projectsError,
      history: this.history.map((item) => ({ ...item })),
      current: this.current === null ? null : { ...this.current },
    };
  }

  subscribe(listener: (snapshot: DelegateSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  async save(input: unknown): Promise<{ ok: boolean; error?: string }> {
    const parsed = saveSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: '委派设置的值不对。' };
    // 根目录填错了要说出来，而不是悄悄退回默认值。
    const badRoot = rootProblem((parsed.data.projectsRoot ?? '').trim());
    if (badRoot !== '') return { ok: false, error: `项目根目录：${badRoot}` };
    const next = normalizeDelegate(parsed.data);
    if (next.target === 'custom') {
      const problem = customBinProblem(next.customBin);
      if (problem !== '') return { ok: false, error: problem };
    }
    try {
      await this.store.save(next);
    } catch {
      return { ok: false, error: '委派设置没有保存成功，请重试。' };
    }
    this.config = next;
    await this.probe();
    return { ok: true };
  }

  /**
   * 探测每个目标装没装。
   *
   * 只查路径、不执行它：跑一次 `--version` 要一两秒，面板一打开就卡；
   * 真正跑起来失败时，错误信息本身已经足够说明问题。
   */
  async probe(): Promise<DelegateSnapshot> {
    const list: DelegateTarget[] = [...delegateTargets, customTarget(this.config)];
    const results: DelegateAvailability[] = [];
    for (const target of list) {
      if (target.id === 'custom' && target.bin.trim() === '') {
        results.push({ id: target.id, label: target.label, available: false, path: '' });
        continue;
      }
      const found = await this.locateTarget(target);
      results.push({
        id: target.id,
        label: target.label,
        available: found !== '',
        path: found,
      });
    }
    this.availability = results;
    await this.scanProjects();
    this.publish();
    return this.snapshot();
  }

  /** PATH 里找可执行文件。Windows 优先 .cmd：npm 装的是 sh + cmd 两个壳，能跑的是后者。 */
  private async locate(bin: string): Promise<string> {
    const command = process.platform === 'win32' ? 'where' : 'which';
    const result = await this.runner({
      command,
      args: [bin],
      cwd: this.workspaceRoot,
      timeoutMs: 5_000,
    }).catch(() => null);
    if (!result || result.code !== 0) return '';
    const lines = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (lines.length === 0) return '';
    if (process.platform === 'win32') {
      const cmd = lines.find((line) => /\.(cmd|bat)$/i.test(line));
      if (cmd !== undefined) return cmd;
      return lines.find((line) => /\.exe$/i.test(line)) ?? '';
    }
    return lines[0] ?? '';
  }

  private async isFile(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }

  /**
   * 随安装包走的 CLI：不在 PATH 里，只能按安装目录找。
   *
   * 候选里有几个盘符是猜的，其中某个可能根本不存在、甚至是个断开的网络盘——
   * 这种 stat 会卡好几秒。所以并行探测，每个只等 400ms，命中一个就够。
   */
  private async bundledCli(): Promise<string> {
    const results = await Promise.all(
      workbuddyCliCandidates().map(async (candidate) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 400);
          timer.unref?.();
        });
        const found = await Promise.race([this.isFile(candidate), timeout]);
        if (timer !== undefined) clearTimeout(timer);
        return found ? candidate : '';
      }),
    );
    return results.find((item) => item !== '') ?? '';
  }

  /**
   * 探测目标：bundled 先按安装目录找，找不到再退回 PATH
   * （用户可能自己装过 codebuddy 命令行）。
   */
  private async locateTarget(target: DelegateTarget): Promise<string> {
    if (target.bundled === true) {
      const cli = await this.bundledCli();
      if (cli !== '') return cli;
    }
    return this.locate(target.bin);
  }

  /** bundled 目标要用 node 跑 CLI 入口：先找 PATH 里的，再找 WorkBuddy 自带的那份。 */
  private async nodePath(): Promise<string> {
    const onPath = await this.locate('node');
    if (onPath !== '') return onPath;
    const base = join(
      process.env['USERPROFILE'] ?? process.env['HOME'] ?? '',
      '.workbuddy',
      'binaries',
      'node',
      'versions',
    );
    try {
      const versions = (await readdir(base)).sort().reverse();
      for (const version of versions) {
        const exe = join(base, version, process.platform === 'win32' ? 'node.exe' : 'node');
        if (await this.isFile(exe)) return exe;
      }
    } catch {
      // 没有这个目录：说明不是 WorkBuddy 装的 node，交给上层报错。
    }
    return '';
  }

  private allowed(): boolean {
    return this.config.allowAgents;
  }

  /** 工具层用它判断「能不能跑系统命令」；开关在面板里。 */
  shellAllowed(): boolean {
    return this.config.allowShell;
  }

  async run(
    input: { task: unknown; target?: unknown; project?: unknown; files?: unknown },
    signal: AbortSignal,
    /**
     * onStarted：校验都过了、进程马上要起时调一次，上层据此把「派出去了」先告诉用户。
     * onOutput：对方的实时输出，只用于显示进度。
     */
    hooks: {
      onStarted?: (info: { target: string; project: string; task: string }) => void;
      onOutput?: (chunk: string) => void;
    } = {},
  ): Promise<DelegateRunResult> {
    const brief = typeof input.task === 'string' ? input.task.trim() : '';
    const problem = taskProblem(brief);
    if (problem !== '') return { ok: false, error: problem };
    // 路径由工具层核过（沙盒或授权目录、存在、可读），这里只管拼进派工单。
    const files = Array.isArray(input.files)
      ? input.files.filter((file): file is string => typeof file === 'string').slice(0, 10)
      : [];
    const task = taskWithFiles(brief, files);
    if (!this.allowed()) {
      return { ok: false, error: '用户还没授权把活外包出去，去控制面板「替它派活」里打开。' };
    }
    if (this.busy) return { ok: false, error: '上一件活还没干完，等它回来再说。' };

    // 在哪里干：模型只给项目名，路径由登记的根目录扫出来，换不成任意目录。
    const wantedProject = typeof input.project === 'string' ? input.project.trim() : '';
    let project: ProjectEntry | undefined;
    if (wantedProject !== '') {
      project = findProject(this.projects, wantedProject);
      if (project === undefined) {
        await this.scanProjects();
        project = findProject(this.projects, wantedProject);
      }
      if (project === undefined) {
        const known = this.projects.slice(0, 15).map((item) => item.name);
        return {
          ok: false,
          error:
            known.length === 0
              ? `还没登记任何项目${this.projectsError ? `（${this.projectsError}）` : ''}，没法在「${wantedProject}」里干。`
              : `没有叫「${wantedProject}」的项目。登记的有：${known.join('、')}${this.projects.length > known.length ? ' 等' : ''}。问问用户是哪一个。`,
        };
      }
    }
    const cwd = project?.path ?? this.workspaceRoot;

    // 按先后试：点名的（或面板定的）先上，不可用就换下一个。
    // 只在「工具本身用不了」时换；干了但没干成、超时、取消都不换——那时可能已经改了文件。
    const requested = isTargetId(input.target) ? input.target : undefined;
    const now = Date.now();
    const cooling = new Set<DelegateTargetId>();
    for (const [id, at] of this.unavailableAt) if (now - at < delegateCooldownMs) cooling.add(id);
    const chain = delegateChain({
      config: this.config,
      requested,
      available: this.availability,
      cooling,
    });

    this.busy = true;
    this.lastTask = task;
    this.lastError = '';
    // 开工前的工作区：结果卡据此说明「开工前已有 N 个文件未提交」。取不到就不记。
    const baseline = this.baselineOf ? await this.baselineOf(cwd).catch(() => null) : null;
    const started = Date.now();
    const context: AttemptContext = { task, brief, files, cwd, project, signal, hooks, started };
    const skipped: string[] = [];
    let last: Attempt | undefined;
    try {
      for (const id of chain) {
        if (signal.aborted) break;
        const attempt = await this.attempt(targetOf(this.config, id), context);
        last = attempt;
        if (attempt.result.ok) {
          this.unavailableAt.delete(id);
          break;
        }
        if (!attempt.retryable) break;
        this.unavailableAt.set(id, Date.now());
        skipped.push(`${attempt.label} ${attempt.reason}`);
      }
    } finally {
      this.busy = false;
      this.current = null;
    }

    let result: DelegateRunResult = last?.result ?? {
      ok: false,
      error: '这次取消了，没派出去。',
    };
    if (last !== undefined && skipped.length > 0) {
      if (result.ok) {
        const switched = `（${skipped.join('；')}，改派给 ${last.label}）`;
        result = {
          ...result,
          text: `${switched}\n\n${result.text}`,
          note: `${switched} ${result.note}`,
        };
      } else if (last.retryable) {
        result = {
          ok: false,
          error: `能用的都试了，都不行：${skipped.join('；')}。最后一个的详情：${result.error}`,
        };
      } else {
        result = {
          ok: false,
          error: `${result.error}（之前 ${skipped.join('；')}，才换到 ${last.label}）`,
        };
      }
    }
    if (!result.ok) this.lastError = result.error;

    // 一个都没跑起来（都没装、缺 node）：和以前一样不记这笔。
    if (last?.launched === true) {
      this.record({
        at: started,
        target: last.label,
        project: project?.name ?? '',
        task: task.slice(0, 200),
        outcome: last.outcome,
        ms: Date.now() - started,
        code: last.code,
        error: result.ok ? '' : result.error.split('\n')[0]!.slice(0, 200),
        cwd,
        ...(baseline ? { baseline } : {}),
        ...(result.ok
          ? { summary: conclusionOf(last.text), tests: testSummaryLines(last.text) }
          : {}),
      });
    }
    this.publish();
    return result;
  }

  /** 用一个具体的工具试一次。retryable 表示「这个工具此刻用不了」，可以换下一个。 */
  private async attempt(target: DelegateTarget, ctx: AttemptContext): Promise<Attempt> {
    const label = target.label;
    const unusable = (reason: string, error: string): Attempt => ({
      label,
      result: { ok: false, error },
      retryable: true,
      reason,
      launched: false,
      outcome: 'failed',
      code: null,
      text: '',
    });
    // 自定义命令配错是配置问题：让你去改，不悄悄换走。
    const misconfigured = (error: string): Attempt => ({
      ...unusable('', error),
      retryable: false,
    });
    if (target.id === 'custom') {
      const bad = customBinProblem(target.bin);
      if (bad !== '') return misconfigured(bad);
    }
    const found = await this.locateTarget(target);
    if (found === '') {
      return unusable(
        '没装',
        `这台机器上没找到 ${target.bin}，先把它装好（或者去面板里换一个目标）。`,
      );
    }
    this.availability = this.availability.map((item) =>
      item.id === target.id ? { ...item, available: true, path: found } : item,
    );

    const argv = delegateCommand(target, ctx.task);
    // 批处理由 cmd.exe 解析整行：任务文字里的引号、`^`、`!` 都可能改变执行结果，
    // 没有完备的转义。自定义 .cmd/.bat 只允许从 stdin 拿任务。
    if (!argv.stdin && process.platform === 'win32' && /\.(cmd|bat)$/i.test(found)) {
      return misconfigured(
        '自定义命令是批处理（.cmd/.bat），任务不能拼进参数：去面板把参数里的 {task} 去掉，让它从标准输入读任务。',
      );
    }
    const runTimeoutMs = delegateTimeoutMs(this.config.timeoutMinutes);
    let command = found;
    let args = [...argv.args, ...fileDirArgs(target.id, ctx.files, ctx.cwd, dirname)];
    // 派活 ID 进环境：对方触发的钩子事件带着它，工作台把那个会话并进这条派活。
    let env: Record<string, string> = { XINBAN_DELEGATE_ID: String(ctx.started) };
    if (target.bundled === true && !/\.exe$/i.test(found)) {
      // 随桌面版发布的入口只带 lite-wb 产物；不设这个变量它会去 require 不存在的
      // dist/codebuddy，然后带着 Cannot find module 以退出码 0 退出（假成功）。
      // WorkBuddy 自己起它时也是这么设的。
      env = { ...env, CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1' };
      // 只有脚本形态的入口才需要 node 去跑；完整版是原生 .exe，直接执行。
      const node = await this.nodePath();
      if (node === '') {
        return unusable(
          '缺 node',
          `找到了 ${target.label} 的命令行，但没找到能跑它的 node。装一下 Node.js 再试。`,
        );
      }
      command = node;
      args = [found, ...args];
    }
    // 探测、找 node 都是异步的：这期间用户可能已经取消了。
    if (ctx.signal.aborted) {
      return {
        ...unusable('', '这次取消了，没派出去。'),
        retryable: false,
        outcome: 'cancelled',
      };
    }
    const projectName = ctx.project?.name ?? '';
    this.current = {
      at: ctx.started,
      target: label,
      project: projectName,
      cwd: ctx.cwd,
      task: ctx.brief.slice(0, 200),
    };
    this.publish();
    ctx.hooks.onStarted?.({ target: label, project: projectName, task: ctx.brief });

    const launched = (
      result: DelegateRunResult,
      outcome: DelegateRecord['outcome'],
      code: number | null,
      reason = '',
      text = '',
    ): Attempt => ({
      label,
      result,
      retryable: reason !== '',
      reason,
      launched: true,
      outcome,
      code,
      text,
    });
    const launchedAt = Date.now();
    try {
      const run = await this.runner({
        command,
        args,
        cwd: ctx.cwd,
        // 预设目标把任务放 stdin；自定义命令写了 {task} 时已经在参数里，不再喂一遍。
        ...(argv.stdin ? { stdin: ctx.task } : {}),
        env,
        timeoutMs: runTimeoutMs,
        signal: ctx.signal,
        ...(ctx.hooks.onOutput ? { onOutput: ctx.hooks.onOutput } : {}),
      });
      const combined = [run.stdout, run.stderr].filter((p) => p.trim() !== '').join('\n');
      const fail = (error: string, reason = ''): Attempt =>
        launched({ ok: false, error }, 'failed', run.code, reason);

      if (ctx.signal.aborted) {
        return launched(
          { ok: false, error: `这次取消了，已经让 ${label} 停下。` },
          'cancelled',
          run.code,
        );
      }
      if (run.spawnError !== '') return fail(`${label} 起不来：${run.spawnError}`, '起不来');
      if (run.timedOut) {
        // 别把跑到一半的东西扔了：用户至少要知道它做到哪、卡在哪一步。
        const partial = combined === '' ? '' : delegateOutput(combined).slice(0, 1_200);
        const minutes = Math.round(runTimeoutMs / 60_000);
        return launched(
          {
            ok: false,
            error:
              `等了 ${minutes} 分钟 ${label} 还没干完，已经把它停了。` +
              `可以把任务拆小，或者去面板把「最长等待」调更长。` +
              (partial === '' ? '' : `\n它停之前留下的输出（不完整，别当成干完了）：\n${partial}`),
          },
          'timeout',
          run.code,
        );
      }
      if (run.code !== 0) {
        if (combined === '') return fail(delegateSilentExit(target), '一启动就退出了');
        const error = delegateErrorText(target, run.code, combined);
        if (run.code === 127 || run.code === 9009) return fail(error, '没装');
        if (delegateUnavailable(combined)) {
          if (error.includes('认证没通过')) return fail(error, '没登录');
          // 上游出错可能发生在干到一半：只有还没产出、刚启动不久才换，否则就是重试付费任务。
          const early = run.stdout.trim() === '' && Date.now() - launchedAt < delegateEarlyFailMs;
          return fail(error, early ? '模型服务出错' : '');
        }
        return fail(error);
      }
      if (delegateCrashed(combined)) {
        // 退出码 0 也可能是崩了：入口脚本在异步里抛错，node 仍以 0 退出。
        return fail(
          `${label} 的命令行自己崩了（缺文件，可能刚升级或安装不完整）。（对方说：${delegateNoiseFree(combined).slice(0, 300)}）`,
          '命令行崩了',
        );
      }
      if (delegateUnauthenticated(combined)) {
        // 退出码 0 也可能是「没登录」：WorkBuddy 的 CLI 就是这样只往 stderr 打一行。
        return fail(delegateErrorText(target, run.code, combined), '没登录');
      }
      // 成功时只要 stdout：Codex 把启动横幅、回显的任务和 token 统计都打在 stderr，
      // 混进来模型会把任务原文当成对方的结论。stdout 空了才退回 stderr。
      // 每次启动都有的固定提示行也不是产出。
      const body = run.stdout.trim() !== '' ? run.stdout : combined;
      const text = delegateOutput(delegateNoiseFree(body));
      this.lastAt = Date.now();
      return launched(
        {
          ok: true,
          text,
          note: `${label}${projectName ? ` · ${projectName}` : ''} · ${text.length} 字`,
          target: label,
        },
        'ok',
        run.code,
        '',
        text,
      );
    } catch {
      return launched({ ok: false, error: `${label} 这次没跑起来。` }, 'failed', null, '起不来');
    }
  }
}

interface AttemptContext {
  task: string;
  brief: string;
  files: string[];
  cwd: string;
  project: ProjectEntry | undefined;
  signal: AbortSignal;
  started: number;
  hooks: {
    onStarted?: (info: { target: string; project: string; task: string }) => void;
    onOutput?: (chunk: string) => void;
  };
}

interface Attempt {
  label: string;
  result: DelegateRunResult;
  /** 这个工具此刻用不了：可以换下一个。 */
  retryable: boolean;
  /** 用不了的原因（「没登录」「没装」…），拼进「Claude Code 没登录，改派给 Codex」。 */
  reason: string;
  /** 进程起来过：要记一笔派活记录。 */
  launched: boolean;
  outcome: DelegateRecord['outcome'];
  code: number | null;
  text: string;
}
