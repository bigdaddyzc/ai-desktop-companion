import { execFile } from 'node:child_process';
import { copyFile, mkdir, open, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  applyHookSignals,
  hookLimits,
  isSandboxCwd,
  parseHookEvents,
  type HookSignal,
} from '../core/hook-events';
import {
  claudeHookCommand,
  claudeHooksStatus,
  codexNotifyArgv,
  codexNotifyStatus,
  installClaudeHooks,
  installCodexNotify,
  parseClaudeSettings,
  uninstallClaudeHooks,
  uninstallCodexNotify,
  type HookTarget,
  type HookTargetStatus,
  type HooksStatus,
} from '../core/hook-install';
import type { WorkProgressState } from '../core/progress';
import { writeTextAtomic } from './atomic';
import type { ProgressOverlay } from './progress';

/**
 * 官方通知钩子的桌面侧：安装器 + 收件箱。
 *
 * 钩子脚本只往 userData/agent-events/events.ndjson 追加；这里盯着那个目录，
 * 把事件叠到工作进度上。走文件而不是本机端口：不开监听、不用鉴权，
 * 芯伴没开的时候事件也不丢，下次启动还能读到。
 */

export interface HookPaths {
  /** userData：脚本与收件箱都放这里。 */
  dataDir: string;
  /** ~/.claude */
  claudeHome: string;
  /** ~/.codex（尊重 CODEX_HOME） */
  codexHome: string;
  /** ~/.workbuddy（尊重 WORKBUDDY_CONFIG_DIR，和 WorkBuddy 自己的取法一致） */
  workbuddyHome: string;
  /** ~/.codebuddy（尊重 CODEBUDDY_CONFIG_DIR）：完整版 CodeBuddy 命令行读这里 */
  codebuddyHome: string;
  /**
   * 钩子脚本的来源文件（src/desktop/hook/xinban-hook.cjs，打包后与 main.cjs 同目录）。
   * 安装时原样复制到 userData/hooks，这样规则只有一份，测试也直接 require 它。
   */
  scriptSource: string;
}

export function defaultHookPaths(dataDir: string, scriptSource: string): HookPaths {
  return {
    dataDir,
    scriptSource,
    claudeHome: process.env['XINBAN_CLAUDE_HOME'] ?? join(homedir(), '.claude'),
    codexHome:
      process.env['XINBAN_CODEX_HOME'] ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex'),
    workbuddyHome:
      process.env['XINBAN_WORKBUDDY_HOME'] ??
      (process.env['WORKBUDDY_CONFIG_DIR']?.trim() || join(homedir(), '.workbuddy')),
    codebuddyHome:
      process.env['XINBAN_CODEBUDDY_HOME'] ??
      (process.env['CODEBUDDY_CONFIG_DIR']?.trim() || join(homedir(), '.codebuddy')),
  };
}

/** 钩子脚本、approve.json、心跳都在这里。 */
export function hooksDir(dataDir: string): string {
  return join(dataDir, 'hooks');
}

export function inboxDir(dataDir: string): string {
  return join(dataDir, 'agent-events');
}

export function inboxPath(dataDir: string): string {
  return join(inboxDir(dataDir), 'events.ndjson');
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** 改用户配置前先留一份：同目录、带时间戳，出事了用户自己能换回去。 */
async function backup(path: string, now: number): Promise<void> {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  await copyFile(path, `${path}.xinban-bak-${stamp}`);
}

function findNode(): Promise<boolean> {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    execFile(finder, ['node'], { timeout: 3_000, windowsHide: true }, (error) =>
      resolve(error === null),
    );
  });
}

export class HookInstaller {
  constructor(
    private readonly paths: HookPaths,
    private readonly now: () => number = Date.now,
    private readonly hasNode: () => Promise<boolean> = findNode,
  ) {}

  private get scriptPath(): string {
    return join(hooksDir(this.paths.dataDir), 'xinban-hook.cjs');
  }

  private get claudeSettings(): string {
    return join(this.paths.claudeHome, 'settings.json');
  }

  private get codexConfig(): string {
    return join(this.paths.codexHome, 'config.toml');
  }

  private get workbuddySettings(): string {
    return join(this.paths.workbuddyHome, 'settings.json');
  }

  private get codebuddySettings(): string {
    return join(this.paths.codebuddyHome, 'settings.json');
  }

  async status(): Promise<HooksStatus> {
    const [claudeCode, codex, workbuddy, codebuddy, node, lastEventAt] = await Promise.all([
      this.settingsStatus(this.claudeSettings),
      this.codexStatus(),
      this.settingsStatus(this.workbuddySettings),
      this.settingsStatus(this.codebuddySettings),
      this.hasNode().catch(() => false),
      stat(inboxPath(this.paths.dataDir)).then(
        (info) => info.mtimeMs,
        () => 0,
      ),
    ]);
    return { claudeCode, codex, workbuddy, codebuddy, node, lastEventAt };
  }

  /** Claude Code 与 WorkBuddy 的 settings.json 同一种格式。 */
  private async settingsStatus(path: string): Promise<HookTargetStatus> {
    try {
      const text = await readOptional(path);
      if (text === null) return { status: 'absent', path, note: '' };
      const parsed = parseClaudeSettings(text);
      if (!parsed.ok) return { status: 'unreadable', path, note: parsed.error };
      return { status: claudeHooksStatus(parsed.value), path, note: '' };
    } catch {
      return { status: 'unreadable', path, note: '读不了 settings.json。' };
    }
  }

  private async codexStatus(): Promise<HookTargetStatus> {
    const path = this.codexConfig;
    try {
      const text = await readOptional(path);
      if (text === null) return { status: 'absent', path, note: '' };
      const status = codexNotifyStatus(text);
      return {
        status,
        path,
        note: status === 'conflict' ? '已有你自己的 notify，芯伴不覆盖。' : '',
      };
    } catch {
      return { status: 'unreadable', path, note: '读不了 config.toml。' };
    }
  }

  /** 脚本每次安装都重写一遍：升级芯伴后点一下「重装」就更新了。 */
  private async writeScript(): Promise<void> {
    await mkdir(dirname(this.scriptPath), { recursive: true });
    await writeTextAtomic(this.scriptPath, await readFile(this.paths.scriptSource, 'utf8'));
    await mkdir(inboxDir(this.paths.dataDir), { recursive: true });
  }

  /**
   * 启动时调一次：已经装过的脚本副本和当前版本不一致就刷新。
   * 否则规则收紧后，对方进程里跑的仍是旧规则——用户不会想到要去点「重装」。
   * 没装过就什么都不做。返回是否刷新了。
   */
  async refreshScript(): Promise<boolean> {
    try {
      const installed = await readOptional(this.scriptPath);
      if (installed === null) return false;
      const source = await readFile(this.paths.scriptSource, 'utf8');
      if (installed === source) return false;
      await writeTextAtomic(this.scriptPath, source);
      return true;
    } catch {
      return false;
    }
  }

  async apply(
    target: HookTarget,
    action: 'install' | 'uninstall',
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      if (action === 'install') await this.writeScript();
      if (target === 'codex') return await this.applyCodex(action);
      if (target === 'workbuddy') {
        return await this.applySettings(this.workbuddySettings, 'workbuddy', action);
      }
      if (target === 'codebuddy') {
        return await this.applySettings(this.codebuddySettings, 'workbuddy', action);
      }
      return await this.applySettings(this.claudeSettings, 'claude', action);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      return { ok: false, error: code ? `写入失败（${code}）。` : '写入失败。' };
    }
  }

  private async applySettings(
    path: string,
    source: 'claude' | 'workbuddy',
    action: 'install' | 'uninstall',
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const text = await readOptional(path);
    if (text === null && action === 'uninstall') return { ok: true };
    const parsed = parseClaudeSettings(text ?? '');
    if (!parsed.ok) return parsed;
    const command = claudeHookCommand(
      'node',
      this.scriptPath,
      inboxPath(this.paths.dataDir),
      source,
    );
    const next =
      action === 'install'
        ? installClaudeHooks(parsed.value, command)
        : uninstallClaudeHooks(parsed.value);
    if (text !== null) {
      if (JSON.stringify(next) === JSON.stringify(parsed.value)) return { ok: true };
      await backup(path, this.now());
    } else {
      await mkdir(dirname(path), { recursive: true });
    }
    // 用户会自己打开这个文件：保持缩进可读。
    await writeTextAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
    return { ok: true };
  }

  private async applyCodex(
    action: 'install' | 'uninstall',
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const path = this.codexConfig;
    const text = await readOptional(path);
    if (text === null && action === 'uninstall') return { ok: true };
    let next: string;
    if (action === 'install') {
      const argv = codexNotifyArgv('node', this.scriptPath, inboxPath(this.paths.dataDir));
      const result = installCodexNotify(text ?? '', argv);
      if (!result.ok) return result;
      next = result.value;
    } else {
      next = uninstallCodexNotify(text ?? '');
    }
    if (text !== null) {
      if (next === text) return { ok: true };
      await backup(path, this.now());
    } else {
      await mkdir(dirname(path), { recursive: true });
    }
    await writeTextAtomic(path, next);
    return { ok: true };
  }
}

/**
 * 收件箱：读钩子事件并叠到进度上。按 mtime+size 缓存，没变就不重读。
 * 读失败只等于「没有钩子事件」，绝不影响日志那一路。
 */
export class HookInbox implements ProgressOverlay {
  private signals: HookSignal[] = [];
  private fingerprint = '';

  constructor(
    private readonly dataDir: string,
    /** 收件箱内容变了时通知（替你确认从这里学你的批准）。失败不影响进度。 */
    private readonly onText?: (text: string) => Promise<void>,
  ) {}

  watchRoot(): string {
    return inboxDir(this.dataDir);
  }

  async refresh(): Promise<void> {
    const path = inboxPath(this.dataDir);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(path, 'r');
      const { size, mtimeMs } = await handle.stat();
      const fingerprint = `${mtimeMs}:${size}`;
      if (fingerprint === this.fingerprint) return;
      const length = Math.min(size, hookLimits.tailBytes);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, size - length);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      if (size > length) text = text.slice(text.indexOf('\n') + 1);
      this.signals = parseHookEvents(text, { dropSandbox: !isSandboxCwd(this.dataDir) });
      this.fingerprint = fingerprint;
      if (this.onText !== undefined) await this.onText(text).catch(() => undefined);
    } catch {
      this.signals = [];
      this.fingerprint = '';
    } finally {
      if (handle !== null) await handle.close().catch(() => undefined);
    }
  }

  apply(state: WorkProgressState, now: number): WorkProgressState {
    return applyHookSignals(state, this.signals, now);
  }
}
