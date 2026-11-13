import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  agentPermissionTitle,
  canRemember,
  decisionFor,
  normalizeRemoteApprove,
  parseAgentPermission,
  remoteApproveLimits,
  type AgentPermissionRequest,
  type RemoteApproveConfig,
} from '../core/agent-permission';
import type { LogFields } from '../core/app-log';
import type { ConfirmOutcome } from '../core/confirm';
import { writeJsonAtomic } from './atomic';
import type { ConfirmService } from './confirm';

export interface AgentPermissionHooks {
  /** 「以后同类都批」：加进替你确认。失败不影响这一次的允许。 */
  remember(request: AgentPermissionRequest): Promise<void>;
  /** 只记来源/工具名/风险/结果/用时，不记命令原文。 */
  log(event: string, fields: LogFields): void;
}

const pendingName = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface Tracked {
  confirmId: string;
  pid: number;
}

/**
 * 远程批准的桌面侧。目录是 userData/hooks（和钩子脚本同目录）：
 * - remote.json：开关与等待时长，只由这里写，钩子只读；
 * - pending/<id>.json：钩子写，这里读；
 * - decisions/<id>.json：这里原子写，钩子读完删掉。
 *
 * 钩子进程没了或 pending 文件被删（对方超时、你在终端里 Ctrl-C）就撤卡，不留孤儿卡片。
 */
export class AgentPermissionBridge {
  private config: RemoteApproveConfig = normalizeRemoteApprove(undefined);
  private readonly tracked = new Map<string, Tracked>();
  private readonly seen = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private scanning = false;

  constructor(
    private readonly dir: string,
    private readonly confirm: ConfirmService,
    private readonly hooks: AgentPermissionHooks,
    private readonly now: () => number = Date.now,
    private readonly isAlive: (pid: number) => boolean = processAlive,
  ) {}

  private get configPath(): string {
    return join(this.dir, 'remote.json');
  }

  private get pendingDir(): string {
    return join(this.dir, 'pending');
  }

  private get decisionsDir(): string {
    return join(this.dir, 'decisions');
  }

  /** 读配置并写回规范化结果（首次运行就是「默认开」）；清掉旧的残留文件。 */
  async load(): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.configPath, 'utf8'));
    } catch {
      raw = undefined;
    }
    this.config = normalizeRemoteApprove(raw);
    await this.persist().catch(() => undefined);
    await this.sweep();
  }

  view(): RemoteApproveConfig {
    return { ...this.config };
  }

  async save(next: RemoteApproveConfig): Promise<void> {
    const config = normalizeRemoteApprove(next);
    const previous = this.config;
    this.config = config;
    try {
      await this.persist();
    } catch (error) {
      this.config = previous;
      throw error;
    }
    if (!config.enabled) this.confirm.deferAllExternal();
  }

  private persist(): Promise<void> {
    return writeJsonAtomic(this.configPath, { v: 1, ...this.config });
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.scan(), remoteApproveLimits.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 超过 10 分钟的 pending/decisions 文件：对方早就不等了。 */
  private async sweep(): Promise<void> {
    const cutoff = this.now() - remoteApproveLimits.staleMs;
    for (const dir of [this.pendingDir, this.decisionsDir]) {
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const name of names) {
        const file = join(dir, name);
        const info = await stat(file).catch(() => null);
        if (info && info.mtimeMs < cutoff) await rm(file, { force: true }).catch(() => undefined);
      }
    }
  }

  /** 扫一遍 pending 目录。测试里直接调。 */
  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const names = await readdir(this.pendingDir).catch(() => [] as string[]);
      const ids = new Set<string>();
      for (const name of names) {
        const match = pendingName.exec(name);
        if (match) ids.add(match[1]!);
      }
      for (const [id, item] of this.tracked) {
        if (!ids.has(id) || !this.isAlive(item.pid)) {
          this.tracked.delete(id);
          this.confirm.dismiss(item.confirmId);
        }
      }
      for (const id of this.seen) if (!ids.has(id)) this.seen.delete(id);
      for (const id of ids) {
        if (this.seen.has(id)) continue;
        this.seen.add(id);
        await this.open(id);
      }
    } finally {
      this.scanning = false;
    }
  }

  private async open(id: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(this.pendingDir, `${id}.json`), 'utf8'));
    } catch {
      return;
    }
    const request = parseAgentPermission(raw, id, this.now());
    if (request === null) return;
    if (!this.config.enabled) {
      await this.decide(request, 'deferred');
      return;
    }
    if (!this.isAlive(request.pid)) return;
    const started = this.now();
    const { id: confirmId, outcome } = this.confirm.requestExternal(
      {
        tool: 'agent_permission',
        title: agentPermissionTitle(request),
        detail: request.detail,
        external: { canRemember: canRemember(request) },
      },
      request.deadline,
    );
    this.tracked.set(id, { confirmId, pid: request.pid });
    void outcome.then(async (result) => {
      this.tracked.delete(id);
      if (result === 'remembered') await this.hooks.remember(request).catch(() => undefined);
      await this.decide(request, result);
      this.hooks.log('agent-permission', {
        source: request.source,
        tool: request.tool,
        risk: request.risk === '' ? 'normal' : 'high',
        outcome: result,
        ms: this.now() - started,
      });
    });
  }

  private async decide(request: AgentPermissionRequest, outcome: ConfirmOutcome): Promise<void> {
    const decision = decisionFor(outcome);
    // 过了截止时间钩子已经走了，写了也没人读、没人删。
    if (decision === null || this.now() >= request.deadline) return;
    await writeJsonAtomic(join(this.decisionsDir, `${request.id}.json`), {
      v: 1,
      id: request.id,
      fp: request.fp,
      decision,
    }).catch(() => undefined);
  }
}
