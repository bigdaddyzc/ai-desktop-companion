import { spawn } from 'node:child_process';
import type { FileAccessService } from './files';
import {
  applyStage,
  assertNotCancelled,
  captureFile,
  discardStage,
  FileTransactionError,
  stageFile,
  type FileState,
} from './file-transaction';
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { Action, CommandResult, Snapshot } from '../core/schema';
import { delegateLimits, taskProblem } from '../core/delegate';
import { checkShellCommand, shellLimits, shellOutput } from '../core/shell';
import {
  looksSensitive,
  memoryCategoryLabels,
  memoryLimits,
  type MemoryFact,
} from '../core/memory';
import { confirmLimits, type ConfirmRequest } from '../core/confirm';
import { chatMessageProblem, chatMessageText } from '../core/phone-push';
import {
  fileRootLimits,
  isNoWritePath,
  isSameOrAncestor,
  isSecretPath,
  normalizeRootPath,
  type FileRoot,
} from '../core/file-roots';
import { changeDetail, textChange } from '../core/text-diff';
import { extensionOf, imageExtensions } from '../core/attachments';
import { mcpLimits } from '../core/mcp';
import { parseDue } from '../core/due';
import { dueLabel } from '../core/device-view';
import { decodeOutput, killTree } from './delegate';
import type { AudioPlayResult } from './audio';
import {
  describeNowPlaying,
  musicLine,
  musicToolInputSchema,
  toolCommand,
  type MusicCommand,
  type NowPlaying,
} from '../core/music';
import {
  clip,
  clipToolOutput,
  describeToolCall,
  formatPage,
  formatSearchResults,
  wrapUntrusted,
  type AgentCallRef,
  type AgentCitation,
  type AgentToolTrace,
} from '../core/agent';

/**
 * 工具的本地执行器。
 *
 * 安全边界（这些不是提示词能兜住的，必须落在代码里）：
 * - 所有文件路径必须解析到工作目录内，拒绝绝对路径、`..` 逃逸与受保护路径；
 * - 命令不经过 shell（`spawn` 的 args 数组），因此管道、重定向、`&&` 拼接都无效；
 * - 命令程序限定白名单，工作目录锁死，有超时与输出上限；
 * - 写文件前备份原文件，保留可回退的 .bak。
 *
 * 需要说清的残留风险：白名单里的 `node -e` 仍然是任意代码执行。
 * 白名单约束的是「用什么跑」，不是「能做什么」；真正的止损在路径、超时与可见轨迹。
 */

export interface ToolJsonResult {
  ok: boolean;
  status: number;
  data: unknown;
}

/** 由主进程注入的能力：出站请求、领域动作与长期记忆。执行器本身不持有 Key。 */
export interface ToolHost {
  postJson(path: string, body: unknown, signal: AbortSignal): Promise<ToolJsonResult>;
  snapshot(): Snapshot;
  dispatch(action: Action): Promise<CommandResult>;
  memory: ToolMemory;
  /** 工作进度观察者；未接入时工具给出「看不到」，而不是假装知道。 */
  progress?: { text(): string };
  /** 耳朵眼睛的读数；只给文字，不含音频与画面。 */
  senses?: { text(): string };
  /** 视觉：把一帧画面换成一段文字。没接就说明「看不见」，不能假装描述。 */
  vision?: {
    look(
      input: { source: 'screen' | 'camera' | 'file'; path?: string; question?: string },
      signal: AbortSignal,
    ): Promise<{ ok: true; text: string; note: string } | { ok: false; error: string }>;
  };
  /** 主动放声音：主进程的音频播放服务。未注入时（只在单测里）工具给出「未接入」。 */
  audio?: { play(input: unknown): Promise<AudioPlayResult> };
  /** 音乐客户端控制（系统媒体控制）。未注入时工具给出「未接入」。 */
  music?: {
    run(
      command: MusicCommand,
    ): Promise<{ ok: true; nowPlaying: NowPlaying | null } | { ok: false; error: string }>;
  };
  /**
   * 派活与命令：委派给外部 Agent，或在授权后跑系统命令。
   * 两项都受面板总开关约束——没开就返回「未授权」，而不是偷偷执行。
   */
  delegate?: ToolDelegate;
  /**
   * 逐次确认：跑命令、看屏幕/摄像头、派活之前先问用户。
   * 返回 false（拒绝或超时）就不执行。主进程总是注入；未注入只在单测里出现。
   */
  confirm?(request: ConfirmRequest, signal: AbortSignal): Promise<boolean>;
  /** 飞书群机器人（desktop/phone-push.ts）。地址不经过这里，只问配没配、发一条。 */
  feishu?: {
    configured(): boolean;
    send(text: string): Promise<{ ok: true } | { ok: false; error: string }>;
  };
  /** 外接的 MCP 工具（desktop/mcp.ts）。名字都以 mcp__ 开头。 */
  mcp?: {
    describe(name: string): { server: string; tool: string; trust: 'ask' | 'auto' } | null;
    call(
      name: string,
      args: unknown,
      signal: AbortSignal,
    ): Promise<{ ok: true; text: string; isError: boolean } | { ok: false; error: string }>;
  };
  /**
   * 用户授权的目录与改动记录（desktop/files.ts）。未注入时只有沙盒工作目录。
   */
  files?: Pick<FileAccessService, 'roots' | 'revision' | 'commit'>;
}

/** 用户没同意时交回模型的话：说清楚没做成，不要换个工具绕过去。 */
export const deniedOutput =
  '用户没有允许这次操作（拒绝了或没有及时确认），它没有执行。直接告诉他没做成，不要换个工具或换个说法再试。';

/** 委派能力的最小接口：由 desktop/delegate.ts 的 DelegateService 实现。 */
export interface ToolDelegate {
  enabled(): boolean;
  shellAllowed(): boolean;
  targets(): { id: string; label: string; available: boolean }[];
  run(
    input: { task: string; target?: string; project?: string; files?: string[] },
    signal: AbortSignal,
  ): Promise<
    | { ok: true; text: string; note: string; target: string; background?: boolean }
    | { ok: false; error: string }
  >;
}

/** 记忆能力的最小接口：由 desktop/memory.ts 的 MemoryService 实现。 */
export interface ToolMemory {
  remember(
    text: string,
    category?: unknown,
    source?: 'said' | 'inferred',
  ): Promise<{ ok: boolean; output: string; note: string }>;
  forget(query: string): Promise<{ removed: string[]; candidates: string[] }>;
  search(query: string, limit?: number): MemoryFact[];
}

export interface ToolExecution {
  /** 交给模型的结果文本（不可信内容已包裹）。 */
  output: string;
  trace: AgentToolTrace;
}

/** 文件与命令的硬上限：防止一次调用把内存、上下文或磁盘写穿。 */
export const toolLimits = {
  maxReadBytes: 256 * 1024,
  maxWriteBytes: 128 * 1024,
  maxListEntries: 200,
  maxCommandOutput: 8_000,
  commandTimeoutMs: 20_000,
  searchQueryChars: 128,
  /** 同一个文件最多保留几份 .bak：反复改同一个文件不该把磁盘堆满备份。 */
  maxBackups: 3,
} as const;

/** Windows 保留设备名：写成文件名会生成删不掉的文件，或直接打到设备上。 */
const deviceNames = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** 可执行程序白名单。npm/npx 不在此列：它们在 Windows 上是 .cmd，必须经 shell 才能跑。 */
const allowedPrograms = new Set(['node', 'git', 'python', 'python3']);

/** 只读但不能写的路径：改了会破坏工程或引入自启动。 */
const protectedPaths = [
  /(^|[\\/])package(-lock)?\.json$/i,
  /(^|[\\/])node_modules([\\/]|$)/i,
  /(^|[\\/])\.git([\\/]|$)/i,
  /\.(cmd|bat|ps1|exe|dll|lnk|vbs)$/i,
];

export class ToolExecutor {
  private readonly root: string;
  private backupStamp = 0;

  constructor(
    private readonly host: ToolHost,
    workspaceRoot: string,
    private readonly now: () => number = Date.now,
    private readonly commandTimeoutMs: number = toolLimits.commandTimeoutMs,
  ) {
    this.root = resolve(workspaceRoot);
  }

  async run(call: AgentCallRef, signal: AbortSignal): Promise<ToolExecution> {
    const label = describeToolCall(call.name, call.arguments);
    try {
      const args = parseArgs(call.arguments);
      const outcome = await this.execute(call.name, args, signal);
      return {
        output: outcome.output,
        trace: {
          callId: call.callId,
          name: call.name,
          label,
          status: 'ok',
          note: outcome.note,
          ...(outcome.citations ? { citations: outcome.citations } : {}),
        },
      };
    } catch (error) {
      const message =
        error instanceof ToolFailure || error instanceof FileTransactionError
          ? error.message
          : '工具执行失败。';
      return {
        output: `工具执行失败：${message}`,
        trace: { callId: call.callId, name: call.name, label, status: 'error', note: message },
      };
    }
  }

  private async execute(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ output: string; note: string; citations?: AgentCitation[] }> {
    switch (name) {
      case 'web_search':
        return this.webSearch(args, signal);
      case 'fetch_page':
        return this.fetchPage(args, signal);
      case 'list_todos':
        return this.listTodos();
      case 'add_todo':
        return this.addTodo(args);
      case 'toggle_todo':
        return this.toggleTodo(args);
      case 'start_timer':
        return this.startTimer(args);
      case 'stop_timer':
        return this.stopTimer();
      case 'list_files':
        return this.listFiles(args);
      case 'read_file':
        return this.readTextFile(args);
      case 'write_file':
        return this.writeTextFile(args, signal);
      case 'edit_file':
        return this.editTextFile(args, signal);
      case 'run_command':
        return this.runCommand(args, signal);
      case 'delegate_task':
        return this.delegateTask(args, signal);
      case 'shell_command':
        return this.shellCommand(args, signal);
      case 'remember_fact':
        return this.rememberFact(args);
      case 'forget_fact':
        return this.forgetFact(args);
      case 'search_memory':
        return this.searchMemory(args);
      case 'work_status':
        return this.workStatus();
      case 'senses':
        return this.sensesStatus();
      case 'look':
        return this.lookAtFrame(args, signal);
      case 'play_audio':
        return this.playAudio(args);
      case 'music':
        return this.music(args);
      case 'send_feishu':
        return this.sendFeishu(args, signal);
      default:
        if (this.host.mcp?.describe(name)) return this.mcpCall(name, args, signal);
        throw new ToolFailure(`没有名为 ${clip(name, 30)} 的工具。`);
    }
  }

  private async webSearch(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ output: string; note: string; citations?: AgentCitation[] }> {
    const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
    if (query === '' || query.length > toolLimits.searchQueryChars) {
      throw new ToolFailure('搜索词为空或超过 128 字。');
    }
    const rawCount = args['count'];
    const count =
      typeof rawCount === 'number' && Number.isFinite(rawCount)
        ? Math.min(10, Math.max(1, Math.trunc(rawCount)))
        : 5;
    const response = await this.host.postJson('/v1/tools/search', { query, count }, signal);
    if (!response.ok) throw new ToolFailure(httpFailure('搜索', response.status));
    const { text, citations } = formatSearchResults(response.data);
    const note = citations.length === 0 ? '没有结果' : `${citations.length} 条结果`;
    return {
      output: wrapUntrusted('web_search', text),
      note,
      ...(citations.length > 0 ? { citations } : {}),
    };
  }

  private async fetchPage(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ output: string; note: string; citations?: AgentCitation[] }> {
    const raw = typeof args['url'] === 'string' ? args['url'].trim() : '';
    if (raw === '' || raw.length > 8192) throw new ToolFailure('链接为空或过长。');
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new ToolFailure('链接格式不正确。');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ToolFailure('只支持 http 或 https 链接。');
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new ToolFailure('链接不能包含账号或密码。');
    }
    const response = await this.host.postJson('/v1/tools/fetch', { url: raw }, signal);
    if (!response.ok) throw new ToolFailure(httpFailure('抓取', response.status));
    const page = formatPage(response.data);
    const citation = page.citation ? { ...page.citation, url: raw, site: parsed.hostname } : null;
    return {
      output: wrapUntrusted('fetch_page', page.text),
      note: `${Math.min(page.text.length, 6_000)} 字`,
      ...(citation ? { citations: [citation] } : {}),
    };
  }

  private listTodos(): { output: string; note: string } {
    const todos = this.host.snapshot().state.todos;
    if (todos.length === 0) return { output: '用户还没有待办。', note: '0 条' };
    const lines = todos.map(
      (todo) =>
        `- [${todo.done ? 'x' : ' '}] ${todo.title}（id: ${todo.id}${
          typeof todo.dueAt === 'number' ? `，${dueLabel(todo.dueAt, this.now())}` : ''
        }）`,
    );
    return {
      output: `共 ${todos.length} 条待办：\n${lines.join('\n')}`,
      note: `${todos.length} 条`,
    };
  }

  private async addTodo(args: Record<string, unknown>): Promise<{ output: string; note: string }> {
    const title = typeof args['title'] === 'string' ? args['title'].trim() : '';
    if (title === '') throw new ToolFailure('待办标题不能为空。');
    const rawDue = typeof args['due'] === 'string' ? args['due'].trim() : '';
    let dueAt: number | undefined;
    if (rawDue !== '') {
      const parsed = parseDue(rawDue, this.now());
      if (!parsed.ok) throw new ToolFailure(parsed.error);
      dueAt = parsed.at;
    }
    const result = await this.host.dispatch({
      type: 'todo.add',
      title: clip(title, 100),
      ...(dueAt !== undefined ? { dueAt } : {}),
    });
    if (!result.ok) throw new ToolFailure(result.error);
    const when = dueAt !== undefined ? `，${dueLabel(dueAt, this.now())}提醒` : '';
    return {
      output: `已添加待办：${clip(title, 100)}${when}`,
      note: dueAt !== undefined ? `已添加 · ${dueLabel(dueAt, this.now())}` : '已添加',
    };
  }

  private async toggleTodo(
    args: Record<string, unknown>,
  ): Promise<{ output: string; note: string }> {
    const id = typeof args['id'] === 'string' ? args['id'] : '';
    const before = this.host.snapshot().state.todos.find((todo) => todo.id === id);
    if (!before) throw new ToolFailure('找不到这个待办 id，请先 list_todos。');
    const result = await this.host.dispatch({ type: 'todo.toggle', id });
    if (!result.ok) throw new ToolFailure(result.error);
    return {
      output: `已把「${before.title}」标记为${before.done ? '未完成' : '已完成'}。`,
      note: before.done ? '改回未完成' : '已完成',
    };
  }

  private async startTimer(
    args: Record<string, unknown>,
  ): Promise<{ output: string; note: string }> {
    const raw = args['minutes'];
    const minutes = typeof raw === 'number' ? raw : Number.NaN;
    // 必须是整数：2.5 不能被悄悄截成 2，那会让用户以为设的是 2 分 30 秒。
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) {
      throw new ToolFailure('分钟数必须是 1~180 的整数。');
    }
    const result = await this.host.dispatch({ type: 'timer.start', minutes });
    if (!result.ok) throw new ToolFailure(result.error);
    return { output: `已开始 ${minutes} 分钟计时。`, note: `${minutes} 分钟` };
  }

  private async stopTimer(): Promise<{ output: string; note: string }> {
    if (this.host.snapshot().state.timer === null) {
      return { output: '当前没有进行中的计时。', note: '没有计时' };
    }
    const result = await this.host.dispatch({ type: 'timer.cancel' });
    if (!result.ok) throw new ToolFailure(result.error);
    return { output: '已停止当前计时。', note: '已停止' };
  }

  private async listFiles(
    args: Record<string, unknown>,
  ): Promise<{ output: string; note: string }> {
    const place = this.locate(typeof args['path'] === 'string' ? args['path'] : '', args['root']);
    const target = await this.resolveChecked(place);
    const entries = await readdir(target, { withFileTypes: true }).catch(() => {
      throw new ToolFailure('目录不存在或无法读取。');
    });
    const visible = entries.filter((entry) => !entry.name.startsWith('.'));
    const shown = visible.slice(0, toolLimits.maxListEntries);
    if (shown.length === 0) return { output: '这是一个空目录。', note: '0 项' };
    const lines = shown.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    const more =
      visible.length > shown.length ? `\n…（还有 ${visible.length - shown.length} 项未列出）` : '';
    // 文件名也是别人能控制的文字：「忽略之前的指令.txt」同样是注入。
    return {
      output: wrapUntrusted('目录列表', lines.join('\n') + more, 8_000),
      note: `${shown.length} 项`,
    };
  }

  private async readTextFile(
    args: Record<string, unknown>,
  ): Promise<{ output: string; note: string }> {
    const path = typeof args['path'] === 'string' ? args['path'] : '';
    const place = this.locate(path, args['root']);
    const target = await this.resolveChecked(place);
    const info = await stat(target).catch(() => {
      throw new ToolFailure('文件不存在。');
    });
    if (!info.isFile()) throw new ToolFailure('目标不是文件。');
    if (info.size > toolLimits.maxReadBytes) throw new ToolFailure('文件过大，超过 256KB 上限。');
    const buffer = await readFile(target).catch(() => {
      throw new ToolFailure('文件无法读取。');
    });
    // 含 NUL 的按二进制处理，不把乱码塞进上下文。
    if (buffer.includes(0)) throw new ToolFailure('这是二进制文件，不能按文本读取。');
    const content = buffer.toString('utf8');
    return {
      output: wrapUntrusted(`读取本地文件 ${clip(path, 60)}`, content, 12_000),
      note: `${Math.min(content.length, 12_000)} 字`,
    };
  }

  private async writeTextFile(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ output: string; note: string }> {
    const path = typeof args['path'] === 'string' ? args['path'] : '';
    const content = typeof args['content'] === 'string' ? args['content'] : '';
    if (Buffer.byteLength(content, 'utf8') > toolLimits.maxWriteBytes)
      throw new ToolFailure('内容超过 128KB 上限。');
    const place = this.locate(path, args['root']);
    const revision = this.host.files?.revision() ?? 0;
    const target = await this.resolveChecked(place, true);
    const expected = captureFile(place.base, target);
    const before = this.readExisting(expected);
    if (!place.sandbox)
      return this.commitWrite(place, expected, before, content, 'write_file', revision, signal);
    await this.commitSandbox(expected, content, signal);
    return {
      output: `${before !== null ? '已覆盖' : '已创建'} ${clip(path, 80)}（${content.length} 字）${before !== null ? '，原文件已备份为 .bak 文件' : ''}。`,
      note: before !== null ? '已覆盖并备份' : '已创建',
    };
  }

  private async commitSandbox(
    expected: FileState,
    after: string,
    signal: AbortSignal,
  ): Promise<void> {
    assertNotCancelled(signal);
    const stage = stageFile(expected, Buffer.from(after, 'utf8'));
    let backup: string | null = null;
    try {
      if (expected.bytes !== null) {
        // Monotonic suffixes keep retention order even within one clock tick.
        // wx prevents overwriting a backup left by an earlier process.
        let saved = false;
        for (let attempt = 0; attempt < 100 && !saved; attempt++) {
          this.backupStamp = Math.max(this.now(), this.backupStamp + 1);
          try {
            const candidate = `${expected.path}.bak-${this.backupStamp}`;
            await writeFile(candidate, expected.bytes, { flag: 'wx' });
            backup = candidate;
            saved = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
              throw new ToolFailure('备份原文件失败，已放弃修改。');
          }
        }
        if (!saved) throw new ToolFailure('备份名称冲突，已放弃修改。');
      }
      try {
        applyStage(expected, stage, () => assertNotCancelled(signal));
      } catch (error) {
        // 没写成就不留孤儿备份，否则会挤掉真正有用的旧备份。
        if (backup) await unlink(backup).catch(() => undefined);
        throw error;
      }
      await pruneBackups(expected.path);
    } finally {
      discardStage(stage);
    }
  }

  private async runCommand(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ output: string; note: string }> {
    const program = typeof args['program'] === 'string' ? args['program'] : '';
    if (!allowedPrograms.has(program)) {
      throw new ToolFailure(`只允许运行 ${[...allowedPrograms].join(' / ')}。`);
    }
    const rawArgs = Array.isArray(args['args']) ? args['args'] : [];
    const list = rawArgs.filter((value): value is string => typeof value === 'string');
    if (list.length !== rawArgs.length) throw new ToolFailure('参数必须是字符串数组。');
    if (list.length > 40) throw new ToolFailure('参数过多。');
    // 卡片上原文展示；展示不下就不问、退回去拆小。
    const commandText = [program, ...list.map(quoteArg)].join(' ');
    if (commandText.length > confirmLimits.maxDetail) {
      throw new ToolFailure(
        `命令太长（${commandText.length} 字），确认卡片放不下全文，拆成几步再跑。`,
      );
    }
    const allowed = await this.ask(
      { tool: 'run_command', title: '想跑一条命令', detail: commandText },
      signal,
    );
    if (!allowed) return { output: deniedOutput, note: '你没允许' };
    const result = await runProcess(program, list, this.root, this.commandTimeoutMs, signal);
    const body = [result.stdout, result.stderr]
      .filter((part) => part !== '')
      .join('\n')
      .trim();
    const clipped = clipToolOutput(
      body === '' ? '（没有输出）' : body,
      toolLimits.maxCommandOutput,
    );
    const status = result.timedOut
      ? '超时终止'
      : result.code === 0
        ? '成功'
        : `退出码 ${result.code}`;
    return {
      output: `命令 ${program} ${list.join(' ')} 结束：${status}\n${wrapUntrusted('命令输出', clipped, toolLimits.maxCommandOutput + 200)}`,
      note: status,
    };
  }

  /**
   * 把一整件事交给外部 Agent。
   *
   * 失败当正常输出交回去（不抛异常）：模型要说的是「没派成，因为它没登录」，
   * 而不是「工具崩了」——后者会让它换个说法再派一次，白等两分钟。
   */
  private async delegateTask(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ output: string; note: string }> {
    if (!this.host.delegate) return { output: '你还没有接上派活的通道。', note: '未接入' };
    const task = typeof args['task'] === 'string' ? args['task'].trim() : '';
    const target = typeof args['target'] === 'string' ? args['target'] : undefined;
    const project =
      typeof args['project'] === 'string' && args['project'].trim() !== ''
        ? args['project'].trim()
        : undefined;
    if (!this.host.delegate.enabled()) {
      return { output: '用户还没开启派活，去控制面板「替它派活」里打开。', note: '未授权' };
    }
    // 随活交出去的文件：只认沙盒（含 uploads/）和授权目录里能读的，换成绝对路径交给对方。
    const files: string[] = [];
    if (Array.isArray(args['files'])) {
      for (const raw of args['files'].slice(0, 10)) {
        if (typeof raw !== 'string' || raw.trim() === '') continue;
        const place = this.locate(raw, undefined);
        const target = await this.resolveChecked(place);
        if (!(await stat(target).catch(() => null))) {
          throw new ToolFailure(`${clip(raw, 80)} 不存在。`);
        }
        files.push(target);
      }
    }
    if (task !== '') {
      // 先校验再问：你点头的必须是完整、会被原样交出去的那段话。
      const problem = taskProblem(task);
      if (problem !== '') return { output: `这次没派成：${problem}`, note: problem };
      const allowed = await this.ask(
        {
          tool: 'delegate_task',
          title: `想把活交给${target ? ` ${clip(target, 20)}` : '编程 Agent（芯伴自动挑）'}${
            project ? `，在项目 ${clip(project, 40)} 里干` : ''
          }`,
          detail:
            files.length === 0
              ? task
              : `${task}\n\n随活交给它的文件：\n${files.map((file) => `- ${file}`).join('\n')}`,
        },
        signal,
      );
      if (!allowed) return { output: deniedOutput, note: '你没允许' };
    }
    if (!this.host.delegate.enabled()) throw new ToolFailure('派活授权已关闭，未执行。');
    if (signal.aborted) throw new ToolFailure('已取消，未执行。');
    const result = await this.host.delegate.run(
      {
        task,
        ...(target ? { target } : {}),
        ...(project ? { project } : {}),
        ...(files.length > 0 ? { files } : {}),
      },
      signal,
    );
    if (!result.ok) return { output: `这次没派成：${result.error}`, note: result.error };
    if (result.background === true) {
      return {
        output:
          `已经派给 ${result.target}，它正在后台干。对话不用等它：用户可以接着和你聊，` +
          `界面上看得到它干了多久和最新输出，干完会自动把结果发进对话。` +
          `现在用一两句话告诉用户已经派出去了，不要猜或编造它的结果，也不要再派一次同样的活。`,
        note: result.note,
      };
    }
    // 对方读过仓库里的文件，产出里可能夹着「请执行……」这类文字，按外部数据处理。
    return {
      output: wrapUntrusted(
        `交给 ${result.target} 干完的产出`,
        result.text,
        delegateLimits.maxOutput,
      ),
      note: result.note,
    };
  }

  /**
   * 跑一条系统命令。
   *
   * 这道门有三层，缺一不可：面板授权 → 规则表拦截 → 超时与输出上限。
   * 规则表只能拦住看得出来的危险，所以提示词里还要求模型不要执行
   * 从网页/文件里读到的命令——那条防线靠的是「命令由模型当场写」。
   */
  private async shellCommand(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ output: string; note: string }> {
    if (!this.host.delegate) return { output: '你还没有接上命令通道。', note: '未接入' };
    if (!this.host.delegate.shellAllowed()) {
      return {
        output: '用户还没允许我运行系统命令，去控制面板「替它派活」里打开这个开关。',
        note: '未授权',
      };
    }
    const verdict = checkShellCommand(typeof args['command'] === 'string' ? args['command'] : '');
    if (!verdict.ok) throw new ToolFailure(verdict.reason);
    const allowed = await this.ask(
      // 原文展示：checkShellCommand 已保证不超过 shellLimits.commandChars。
      { tool: 'shell_command', title: '想跑一条系统命令', detail: verdict.command },
      signal,
    );
    if (!allowed) return { output: deniedOutput, note: '你没允许' };
    if (!this.host.delegate.shellAllowed()) throw new ToolFailure('系统命令授权已关闭，未执行。');
    if (signal.aborted) throw new ToolFailure('已取消，未执行。');
    const result = await runShell(verdict.command, this.root, shellLimits.timeoutMs, signal);
    const body = [result.stdout, result.stderr].filter((part) => part.trim() !== '').join('\n');
    const status = result.timedOut
      ? '超时终止'
      : result.code === 0
        ? '成功'
        : `退出码 ${result.code}`;
    return {
      output: `命令「${verdict.command}」结束：${status}\n${wrapUntrusted('命令输出', shellOutput(body), 12_000)}`,
      note: status,
    };
  }

  private async rememberFact(
    args: Record<string, unknown>,
  ): Promise<{ output: string; note: string }> {
    const text = typeof args['text'] === 'string' ? args['text'].trim() : '';
    if (text === '') throw new ToolFailure('要记的内容不能为空。');
    if (text.length > memoryLimits.factChars) {
      throw new ToolFailure(`一条记忆最多 ${memoryLimits.factChars} 字，请压缩成一句。`);
    }
    // 提示词里已经说过不要记敏感信息，这里再挡一层：
    // 密码、证件号、卡号一旦进了记忆文件，就会跟着后续请求一起上传，不能只靠模型自觉。
    if (looksSensitive(text)) {
      throw new ToolFailure('这类敏感信息不记录，请你放到密码管理器里。');
    }
    const result = await this.host.memory.remember(text, args['category']);
    if (!result.ok) throw new ToolFailure(result.output);
    return { output: result.output, note: result.note };
  }

  private async forgetFact(
    args: Record<string, unknown>,
  ): Promise<{ output: string; note: string }> {
    const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
    if (query === '') throw new ToolFailure('要忘掉什么？给几个关键词。');
    const { removed, candidates } = await this.host.memory.forget(query);
    if (candidates.length > 0) {
      return {
        output: `「${clip(query, 20)}」匹配到 ${candidates.length} 条，太多了，这次一条都没删。问清楚他要忘哪条，再用更具体的说法：${candidates
          .slice(0, 6)
          .map((item) => clip(item, 30))
          .join('；')}`,
        note: `匹配 ${candidates.length} 条，未删`,
      };
    }
    if (removed.length === 0) return { output: '记忆里没有匹配的内容。', note: '没有匹配' };
    return {
      output: `已忘掉 ${removed.length} 条：${removed.map((item) => clip(item, 40)).join('；')}`,
      note: `${removed.length} 条`,
    };
  }

  private searchMemory(args: Record<string, unknown>): { output: string; note: string } {
    const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
    const items = this.host.memory.search(query, 8);
    if (items.length === 0) return { output: '关于这个，记忆里没有相关内容。', note: '0 条' };
    const lines = items.map((fact) => `- [${memoryCategoryLabels[fact.category]}] ${fact.text}`);
    return {
      output: `记忆里找到 ${items.length} 条：\n${lines.join('\n')}`,
      note: `${items.length} 条`,
    };
  }

  /**
   * 工作进度：读的是别人家（WorkBuddy）落在磁盘上的会话记录。
   * 只读、只报告；看不到就说看不到，不猜。
   */
  private workStatus(): { output: string; note: string } {
    if (!this.host.progress) {
      return { output: '现在看不到你在别处的工作进度。', note: '未接入' };
    }
    const text = this.host.progress.text();
    const note = text.includes('读不到') || text.includes('没有看到') ? '没有活跃会话' : '已读取';
    return { output: wrapUntrusted('本机会话记录', text, 2_000), note };
  }

  /**
   * 耳朵与眼睛的现状。
   *
   * 这里唯一可能「知道得太多」的地方是模型把它当成视觉能力。
   * 所以输出里反复写明：只有音量、只有有没有人动，画面从来没离开过渲染进程。
   */
  private sensesStatus(): { output: string; note: string } {
    if (!this.host.senses) {
      return { output: '你还没有接上耳朵和眼睛。', note: '未接入' };
    }
    const text = this.host.senses.text();
    const note = text.includes('都是关的') ? '都没开' : '已读取';
    return { output: text, note };
  }

  /**
   * 看一眼画面。
   *
   * 这一层只做参数与错误的转译：真正的截图、编码、出站都在视觉服务里。
   * 失败也当正常输出交回模型（而不是抛异常），因为它要说的是「没看成，因为 X」，
   * 而不是「工具崩了」——后者会让它换个说法再试一次，白白多花一次截图。
   */
  private async lookAtFrame(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ output: string; note: string }> {
    const source =
      args['source'] === 'camera' ? 'camera' : args['source'] === 'file' ? 'file' : 'screen';
    const question = typeof args['question'] === 'string' ? args['question'] : '';
    if (!this.host.vision) {
      return { output: '你还没有眼睛，看不到画面。', note: '未接入' };
    }
    if (source === 'file') {
      // 看图片文件和 read_file 同一套读权限：沙盒（含拖进来的 uploads/）与授权目录，不再单独问。
      const path = typeof args['path'] === 'string' ? args['path'] : '';
      if (path.trim() === '') throw new ToolFailure('source=file 时要给 path。');
      const target = await this.resolveChecked(this.locate(path, args['root']));
      if (!imageExtensions.has(extensionOf(target))) {
        throw new ToolFailure('这不是图片（支持 png/jpg/webp/gif/bmp）；文本用 read_file。');
      }
      if (!(await stat(target).catch(() => null))?.isFile()) throw new ToolFailure('图片不存在。');
      const result = await this.host.vision.look({ source, path: target, question }, signal);
      if (!result.ok) return { output: `这次没看成：${result.error}`, note: result.error };
      return { output: wrapUntrusted('图片描述', result.text, 6_000), note: result.note };
    }
    const allowed = await this.ask(
      {
        tool: 'look',
        title: source === 'camera' ? '想用摄像头看一眼' : '想看一眼你的屏幕',
        detail: question !== '' ? clip(question, 120) : '看完只留文字描述，图不保存',
      },
      signal,
    );
    if (!allowed) return { output: deniedOutput, note: '你没允许' };
    const result = await this.host.vision.look({ source, question }, signal);
    if (!result.ok) {
      return { output: `这次没看到画面：${result.error}`, note: result.error };
    }
    // 屏幕上的文字同样可能是注入：一个写着「忽略上文」的网页，转述后还是那句话。
    return { output: wrapUntrusted('画面描述', result.text, 6_000), note: result.note };
  }

  /**
   * 调用外接的 MCP 工具。默认每次先问（卡上是参数），用户在面板里标了免确认的才直接跑。
   * 对方返回的一律当外部数据；对方标了 isError 也原样交回，让模型说清楚哪里不对。
   */
  private async mcpCall(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ output: string; note: string }> {
    const mcp = this.host.mcp!;
    const info = mcp.describe(name);
    if (!info) throw new ToolFailure('这个工具现在不可用。');
    if (info.trust !== 'auto') {
      let shown = '';
      try {
        shown = JSON.stringify(args, null, 1);
      } catch {
        shown = '（参数无法显示）';
      }
      const allowed = await this.ask(
        {
          tool: 'mcp',
          title: `想用 ${clip(info.server, 24)} 的 ${clip(info.tool, 40)}`,
          detail: clip(shown === '{}' ? '（没有参数）' : shown, mcpLimits.argsDetailChars),
        },
        signal,
      );
      if (!allowed) return { output: deniedOutput, note: '你没允许' };
    }
    const result = await mcp.call(name, args, signal);
    if (!result.ok) throw new ToolFailure(result.error);
    const body = wrapUntrusted(
      `MCP ${info.server}/${info.tool}`,
      result.text,
      mcpLimits.outputChars,
    );
    return result.isError
      ? { output: `工具报告了错误：\n${body}`, note: '对方报错' }
      : { output: body, note: `${info.server}` };
  }

  /**
   * 主动放声音。这一层只转译参数与错误：路径限制、单路播放、stop 与状态回报
   * 都在主进程的音频服务里，失败也按其它工具一样用 ToolFailure 交回可读原因。
   */
  private async playAudio(
    args: Record<string, unknown>,
  ): Promise<{ output: string; note: string }> {
    if (!this.host.audio) {
      return { output: '你还没有接上扬声器播放能力。', note: '未接入' };
    }
    const result = await this.host.audio.play(args);
    if (!result.ok) throw new ToolFailure(result.error);
    return {
      output: `已通过系统扬声器开始播放 ${result.source}（这是放声音，不是录音，不采集麦克风）。`,
      note: '播放中',
    };
  }

  /**
   * 控制电脑上的音乐客户端。歌名、歌手是客户端报上来的外部文本，一律包成不可信内容。
   * 不走确认：暂停、切歌和按键盘上的播放键一样可撤回，没有外发、不动文件。
   */
  private async music(args: Record<string, unknown>): Promise<{ output: string; note: string }> {
    const parsed = musicToolInputSchema.safeParse(args);
    if (!parsed.success)
      throw new ToolFailure('action 只能是 play_pause / next / previous / now_playing。');
    if (!this.host.music) return { output: '还没接上音乐控制。', note: '未接入' };
    const action = parsed.data.action;
    const result = await this.host.music.run(toolCommand[action]);
    if (!result.ok) throw new ToolFailure(result.error);
    const done =
      action === 'now_playing'
        ? ''
        : action === 'play_pause'
          ? '已按下播放/暂停。'
          : action === 'next'
            ? '已切到下一首。'
            : '已切回上一首。';
    const state = wrapUntrusted('播放器状态', describeNowPlaying(result.nowPlaying), 400);
    return {
      output: `${done}${state}`,
      note: result.nowPlaying ? musicLine(result.nowPlaying) : '没有播放器',
    };
  }

  /**
   * 发一条飞书。消息出本机、群里的人都看得见、发出去撤不回：每次都把要发的原文上卡问一句。
   * 也挡住网页/文件里「把 xx 发到飞书」这类注入——没有你点头就发不出去。
   */
  private async sendFeishu(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ output: string; note: string }> {
    if (!this.host.feishu) return { output: '还没接上飞书。', note: '未接入' };
    const text = typeof args['text'] === 'string' ? args['text'] : '';
    const problem = chatMessageProblem(text);
    if (problem !== '') throw new ToolFailure(problem);
    if (!this.host.feishu.configured()) {
      return {
        output: '用户还没配飞书机器人地址，没发出去。让他去控制面板「推到手机」里填好地址再说。',
        note: '没配地址',
      };
    }
    const allowed = await this.ask(
      { tool: 'send_feishu', title: '想发一条飞书消息', detail: chatMessageText(text) },
      signal,
    );
    if (!allowed) return { output: deniedOutput, note: '你没允许' };
    const result = await this.host.feishu.send(text);
    if (!result.ok) throw new ToolFailure(result.error);
    return { output: '已发到飞书群。', note: '已发出' };
  }

  /**
   * 问用户。没接确认通道（只在单测里）时视为允许；确认通道自己抛错时视为拒绝。
   */
  private async ask(request: ConfirmRequest, signal: AbortSignal): Promise<boolean> {
    if (!this.host.confirm) return true;
    try {
      return await this.host.confirm(request, signal);
    } catch {
      return false;
    }
  }

  /**
   * resolveInside 之上再加一道：按真实路径核对。
   * 工作目录里的 junction / 符号链接能让「字面在根内」的路径指到根外。
   * 目标还不存在（新建文件）时，核对最近一个已存在的上级目录。
   */
  private async resolveChecked(place: FilePlace, forWrite = false): Promise<string> {
    const target = this.resolveInside(place, forWrite);
    const realRoot = await realpath(place.base).catch(() => place.base);
    let probe = target;
    for (;;) {
      const real = await realpath(probe).catch(() => null);
      if (real !== null) {
        if (real !== realRoot && !real.startsWith(realRoot + sep)) {
          throw new ToolFailure(
            `路径经链接指向了${place.sandbox ? '工作目录' : `目录 ${place.name} `}之外。`,
          );
        }
        if (real !== realRoot) checkPlacePath(place, real, forWrite);
        return target;
      }
      const parent = dirname(probe);
      if (parent === probe) return target;
      probe = parent;
    }
  }

  /**
   * 把相对路径解析到工作目录内。
   * 绝对路径、`..` 逃逸、空字节一律拒绝；写入时再拦受保护路径。
   * 这是整个工具层最重要的硬边界，不能只靠「模型会守规矩」。
   */
  private resolveInside(place: FilePlace, forWrite = false): string {
    const root = place.base;
    const path = place.relative.trim();
    if (path.includes('\0')) throw new ToolFailure('路径包含非法字符。');
    if (path.startsWith('/') || path.startsWith('\\') || /^[a-zA-Z]:/.test(path)) {
      throw new ToolFailure('只接受相对于工作目录的路径。');
    }
    // NTFS 数据流（x.cmd::$DATA、.git::$INDEX_ALLOCATION）与 8.3 短名（GIT~1）都能绕过保护名单。
    if (path.includes(':')) throw new ToolFailure('路径里不能有冒号。');
    const segments = path.split(/[\\/]+/).filter((part) => part !== '' && part !== '.');
    for (const segment of segments) {
      if (/~\d/.test(segment)) throw new ToolFailure('不接受短文件名写法，请用完整名称。');
      if (deviceNames.test(segment)) throw new ToolFailure('这是系统保留的设备名，不能当文件名。');
      if (segment !== '..' && /[. ]$/.test(segment)) {
        throw new ToolFailure('文件名不能以点或空格结尾。');
      }
    }
    const target = resolve(root, path === '' ? '.' : path);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new ToolFailure(
        `路径超出了${place.sandbox ? '工作目录' : `目录 ${place.name} `}范围。`,
      );
    }
    if (target !== root) checkPlacePath(place, target, forWrite);
    return target;
  }

  /**
   * 把「root 名 + 相对路径」或「绝对路径」对应到一个可用目录。
   * 只认沙盒和用户在面板里授权的目录；对不上就列出能用的，不替模型猜。
   */
  private locate(rawPath: string, rawRoot: unknown): FilePlace {
    const path = rawPath.trim();
    const rootName = typeof rawRoot === 'string' ? rawRoot.trim() : '';
    const roots = this.host.files?.roots() ?? [];
    const sandbox: FilePlace = {
      name: 'workspace',
      base: this.root,
      sandbox: true,
      writable: true,
      relative: path,
    };
    const known = () =>
      roots.length === 0
        ? '用户还没在面板里授权任何目录；要动用户的文件，请用户在「问问伙伴 → 授权目录」里添加。'
        : `能用的目录：workspace（沙盒）、${roots.map((root) => `${root.name}（${root.path}）`).join('、')}。`;
    // 嵌套时取最深的那个：它的权限设置更具体（外层可写不能覆盖内层只读）。
    const deepest = (target: string): FilePlace | undefined => {
      const hit = [sandbox, ...roots.map((root) => placeOf(root, ''))]
        .filter((candidate) => isSameOrAncestor(candidate.base, target))
        .sort((a, b) => b.base.length - a.base.length)[0];
      if (!hit) return undefined;
      const relative = normalizeRootPath(target)
        .slice(normalizeRootPath(hit.base).length)
        .replace(/^[\\/]+/, '');
      return { ...hit, relative };
    };
    const absolute = /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\');
    if (absolute) {
      const hit = deepest(path);
      if (!hit) throw new ToolFailure(`${clip(path, 80)} 不在工作目录或授权目录里。${known()}`);
      return hit;
    }
    if (rootName === '' || rootName.toLowerCase() === 'workspace') return sandbox;
    const root = roots.find((item) => item.name.toLowerCase() === rootName.toLowerCase());
    if (!root) throw new ToolFailure(`没有叫 ${clip(rootName, 24)} 的目录。${known()}`);
    const place = placeOf(root, path);
    const target = resolve(place.base, path === '' ? '.' : path);
    // 越界的留给 resolveChecked 报错；界内改用最深的授权目录。
    if (!isSameOrAncestor(place.base, target)) return place;
    return deepest(target) ?? place;
  }

  /** 写前读原文，用来生成 diff。不存在返回 null；二进制或太大就不覆盖。 */
  private readExisting(expected: FileState): string | null {
    const buffer = expected.bytes;
    if (buffer === null) return null;
    if (buffer.includes(0)) throw new ToolFailure('原文件是二进制文件，不能按文本改。');
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
    } catch {
      throw new ToolFailure('原文件不是有效 UTF-8 文本，不能直接覆盖。');
    }
  }

  /**
   * 改文件里的一段。原文必须唯一匹配（除非 replace_all）：匹配到多处时不替模型猜是哪一处。
   * 文件是 CRLF、模型给的是 LF 时自动对齐换行。
   */
  private async editTextFile(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ output: string; note: string }> {
    const path = typeof args['path'] === 'string' ? args['path'] : '';
    let oldText = typeof args['old_text'] === 'string' ? args['old_text'] : '';
    let newText = typeof args['new_text'] === 'string' ? args['new_text'] : '';
    const replaceAll = args['replace_all'] === true;
    if (oldText === '') throw new ToolFailure('old_text 不能为空；新建文件用 write_file。');
    const place = this.locate(path, args['root']);
    const revision = this.host.files?.revision() ?? 0;
    const target = await this.resolveChecked(place, true);
    const expected = captureFile(place.base, target);
    const before = this.readExisting(expected);
    if (before === null) throw new ToolFailure('文件不存在；新建用 write_file。');
    if (before.includes('\r\n')) {
      // CRLF 文件：无论原文是否直接匹配，新文本都对齐成 CRLF，避免混入裸 LF。
      if (!before.includes(oldText) && !oldText.includes('\r\n'))
        oldText = oldText.replace(/\n/g, '\r\n');
      newText = newText.replace(/\r?\n/g, '\r\n');
    }
    const count = before.split(oldText).length - 1;
    if (count === 0) {
      throw new ToolFailure(
        '文件里没找到这段原文（要一字不差，包括缩进）；先 read_file 看一下现在的内容。',
      );
    }
    if (count > 1 && !replaceAll) {
      throw new ToolFailure(
        `这段原文在文件里出现了 ${count} 处：多带几行上下文让它唯一，或者设 replace_all。`,
      );
    }
    const after = replaceAll
      ? before.split(oldText).join(newText)
      : before.replace(oldText, () => newText);
    if (Buffer.byteLength(after, 'utf8') > toolLimits.maxWriteBytes)
      throw new ToolFailure('改完超过 128KB 上限。');
    if (place.sandbox) {
      await this.commitSandbox(expected, after, signal);
      return {
        output: `已修改 ${clip(path, 80)}（${count} 处），原文件已备份。`,
        note: `改了 ${count} 处`,
      };
    }
    return this.commitWrite(place, expected, before, after, 'edit_file', revision, signal);
  }

  /**
   * 写授权目录：先问（卡上是 diff），允许后备份、登记改动，再写。
   * 备份失败就不写：不能撤销的改动不做。
   */
  private async commitWrite(
    place: FilePlace,
    expected: FileState,
    before: string | null,
    after: string,
    tool: 'write_file' | 'edit_file',
    revision: number,
    signal: AbortSignal,
  ): Promise<{ output: string; note: string }> {
    if (!place.writable) {
      throw new ToolFailure(`目录 ${place.name} 是只读的；要改请用户在面板里给它开写权限。`);
    }
    if (!this.host.files) throw new ToolFailure('文件改动记录没接上，不能写授权目录。');
    if (before !== null && before === after) {
      return { output: '内容和原来一样，没有改动。', note: '没变化' };
    }
    const shown = `${place.name}/${place.relative.replace(/\\/g, '/')}`;
    const detail = changeDetail(
      `${before === null ? '新建' : '修改'} ${expected.path}`,
      textChange(before ?? '', after),
      fileRootLimits.diffChars,
    );
    const allowed = await this.ask(
      { tool, title: `${before === null ? '新建' : '改'} ${clip(shown, 40)}`, detail },
      signal,
    );
    if (!allowed) return { output: deniedOutput, note: '没允许' };
    await this.host.files.commit(
      { root: place.name, expected, after: Buffer.from(after, 'utf8'), tool, revision },
      signal,
    );
    return {
      output: `${before === null ? '已新建' : '已修改'} ${shown}（${after.length} 字）。用户可以在面板「文件改动」里撤销。`,
      note: before === null ? '已新建' : '已修改，可撤销',
    };
  }
}

/** 一次文件操作落在哪个目录、相对路径是什么。 */
interface FilePlace {
  name: string;
  base: string;
  sandbox: boolean;
  writable: boolean;
  relative: string;
}

function placeOf(root: FileRoot, relative: string): FilePlace {
  return {
    name: root.name,
    base: resolve(root.path),
    sandbox: false,
    writable: root.writable,
    relative,
  };
}

/** 沙盒沿用原来的保护名单；授权目录另有一套：密钥类不读不写，工具配置与可执行的不写。 */
function checkPlacePath(place: FilePlace, target: string, forWrite: boolean): void {
  if (place.sandbox) {
    if (forWrite && protectedPaths.some((pattern) => pattern.test(target))) {
      throw new ToolFailure('该路径受保护，不允许写入。');
    }
    return;
  }
  if (isSecretPath(target)) throw new ToolFailure('这是密钥或凭据类文件，芯伴不读也不写。');
  if (forWrite && isNoWritePath(target)) {
    throw new ToolFailure('这里是版本库、依赖、工具配置或可执行文件，不允许写入。');
  }
}

class ToolFailure extends Error {}

/** 只留最近几份 .bak-时间戳，更早的删掉。删不掉不影响这次写入。 */
async function pruneBackups(target: string): Promise<void> {
  const prefix = `${basename(target)}.bak-`;
  const entries = await readdir(dirname(target)).catch(() => [] as string[]);
  const backups = entries
    .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
  for (const stale of backups.slice(toolLimits.maxBackups)) {
    await rm(join(dirname(target), stale), { force: true }).catch(() => undefined);
  }
}

/** 确认卡上展示用：带空格、引号或空串的参数加引号，参数边界一眼看得出。 */
function quoteArg(arg: string): string {
  return arg === '' || /[\s"']/.test(arg) ? JSON.stringify(arg) : arg;
}

function parseArgs(raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {};
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    throw new ToolFailure('工具参数不是有效 JSON。');
  }
}

function httpFailure(what: string, status: number): string {
  if (status === 401) return `${what}失败：API Key 无效。`;
  if (status === 402) return `${what}失败：账户余额不足。`;
  if (status === 403) return `${what}被安全策略拒绝。`;
  if (status === 404) return `${what}失败：页面不可用或没有可提取正文。`;
  if (status === 408 || status === 504) return `${what}超时。`;
  if (status === 429) return `${what}被限流，稍后再试。`;
  if (status >= 500) return `${what}服务暂时不可用。`;
  return `${what}失败（HTTP ${status}）。`;
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** 不经 shell 直接起进程：args 数组里的内容不会被解释成命令分隔符。 */
function runProcess(
  program: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ProcessResult> {
  return spawnCollect(program, args, cwd, timeoutMs, signal, program);
}

/**
 * 经由 shell 跑一条命令（面板授权后才走得到这里）。
 *
 * 为什么写临时 .cmd 而不是 `cmd /c "命令"`：Node 传参数给 Windows 时按 MSVCRT 规则
 * 加引号，cmd.exe 又按另一套规则拆，命令里带 `"` 时两边会打架——`git commit -m "x"`
 * 就是典型。把命令原样落成 .cmd 再执行，命令行上只有一个文件路径，不存在转义问题。
 * 临时文件用完就删，不落在工作目录里。
 */
async function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ProcessResult> {
  if (signal.aborted) throw new ToolFailure('已取消。');
  if (process.platform !== 'win32') {
    return spawnCollect('/bin/sh', ['-c', command], cwd, timeoutMs, signal, 'sh');
  }
  const directory = await mkdtemp(join(tmpdir(), 'xinban-cmd-')).catch(() => {
    throw new ToolFailure('临时目录建不出来，这条命令没跑。');
  });
  try {
    const file = join(directory, 'run.cmd');
    // @echo off：不让命令本身回显，否则模型会把命令当成执行结果读。
    // chcp 65001：脚本是 UTF-8 写的，输出也按 UTF-8 解码；中文系统默认 GBK 代码页会乱码。
    await writeFile(file, `@echo off\r\nchcp 65001 >nul\r\n${command}\r\n`, 'utf8').catch(() => {
      throw new ToolFailure('命令脚本没写成，这条没跑。');
    });
    // 临时目录可能带空格（用户名里有空格）。用 cmd 自己的引号规则：/s /c ""路径""，
    // 并关掉 Node 的转义（verbatim），否则路径会被拆开。
    return await spawnCollect(
      process.env['ComSpec'] ?? 'cmd.exe',
      ['/d', '/s', '/c', `""${file}""`],
      cwd,
      timeoutMs,
      signal,
      '命令',
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 按字节收集子进程输出，结束时一次解码。
 * 逐块 toString 会把恰好落在分块边界上的中文字拆成两半，变成「��」；
 * 整体解码还能顺带识别 cmd 用 GBK 吐出来的报错。
 */
export function outputCollector(capBytes: number): {
  push(chunk: Buffer): void;
  text(): string;
} {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    push(chunk) {
      if (size >= capBytes) return;
      chunks.push(chunk);
      size += chunk.length;
    },
    text() {
      return decodeOutput(Buffer.concat(chunks));
    },
  };
}

function spawnCollect(
  program: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  label: string,
  verbatim = false,
): Promise<ProcessResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal.aborted) {
      rejectPromise(new ToolFailure('已取消。'));
      return;
    }
    const child = spawn(program, [...args], {
      cwd,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      // stdin 关掉：`git commit` 不带 -m、`python` 不带参数都会等输入，白白卡满超时。
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    });
    // 中文按 UTF-8 占 3 字节：字节上限给到字符上限的 6 倍，和原来「2 倍字符」大致相当。
    const stdout = outputCollector(toolLimits.maxCommandOutput * 6);
    const stderr = outputCollector(toolLimits.maxCommandOutput * 6);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const onAbort = (): void => {
      killTree(child);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      rejectPromise(new ToolFailure(`无法启动 ${label}，请确认它已安装并在 PATH 中。`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolvePromise({ code, stdout: stdout.text(), stderr: stderr.text(), timedOut });
    });
  });
}
