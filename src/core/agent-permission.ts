import { z } from 'zod';
import { confirmLimits, type ConfirmOutcome } from './confirm';

/**
 * 远程批准：Claude Code / WorkBuddy 弹权限请求时，芯伴亮出确认卡，你在桌宠/面板/实体键上答。
 *
 * 钩子写 hooks/pending/<id>.json，芯伴写 hooks/decisions/<id>.json；不开端口。
 * 超时与芯伴自己的工具不同：外部 Agent 没人理 = 交回终端，不替你拒、也不替你批。
 * 请求内容来自另一个进程写的文件，一律当不可信输入校验。
 *
 * 纯领域层：类型、校验、文案；目录监听与写文件在 desktop/agent-permission.ts。
 */

export const remoteApproveLimits = {
  /** 可选等待时长。钩子 timeout 是 95 秒（hook-install.ts），换档不用重装钩子。 */
  waitChoicesMs: [20_000, 45_000, 90_000],
  /** 2026-11-12 用户定：45 秒。 */
  defaultWaitMs: 45_000,
  /** 钩子自己的上限（xinban-hook.cjs 的 REMOTE_MAX_WAIT_MS）。 */
  maxWaitMs: 90_000,
  /** 外部请求单独排队，不挤占芯伴自己工具的确认。多出来的直接交回终端。 */
  queue: 4,
  /** 启动时清理这么久以前的残留文件。 */
  staleMs: 10 * 60_000,
  /** 扫 pending 目录的周期。验收要求从弹请求到出卡 < 1 秒。 */
  pollMs: 250,
} as const;

export interface RemoteApproveConfig {
  /** 2026-11-12 用户定：默认开（只是多一个确认入口，不替你做决定）。 */
  enabled: boolean;
  waitMs: number;
}

export const defaultRemoteApprove: RemoteApproveConfig = {
  enabled: true,
  waitMs: remoteApproveLimits.defaultWaitMs,
};

export function isWaitChoice(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    (remoteApproveLimits.waitChoicesMs as readonly number[]).includes(value)
  );
}

/** remote.json → 配置。没有或坏了就是默认值。 */
export function normalizeRemoteApprove(raw: unknown): RemoteApproveConfig {
  if (typeof raw !== 'object' || raw === null) return { ...defaultRemoteApprove };
  const value = raw as Record<string, unknown>;
  return {
    enabled:
      typeof value['enabled'] === 'boolean' ? value['enabled'] : defaultRemoteApprove.enabled,
    waitMs: isWaitChoice(value['waitMs']) ? value['waitMs'] : defaultRemoteApprove.waitMs,
  };
}

export type AgentPermissionSource = 'claude-code' | 'workbuddy';

export interface AgentPermissionRequest {
  id: string;
  /** 工具参数指纹：decision 文件必须带同一个，对不上钩子当没看见。 */
  fp: string;
  source: AgentPermissionSource;
  tool: string;
  cwd: string;
  /** 命令/文件路径/网址原文，不截断；超长的钩子根本不会交过来。 */
  detail: string;
  keys: string[];
  /** 非空 = 高风险或认不出：不给「以后同类都批」。 */
  risk: string;
  at: number;
  deadline: number;
  pid: number;
}

export type AgentDecision = 'allow' | 'deny' | 'defer';

const pendingSchema = z.object({
  v: z.literal(1),
  id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  fp: z.string().regex(/^[0-9a-f]{16}$/),
  src: z.enum(['claude-code', 'workbuddy']),
  tool: z.string().min(1).max(60),
  cwd: z.string().max(300),
  detail: z.string().min(1).max(confirmLimits.maxDetail),
  keys: z.array(z.string().min(1).max(80)).max(6),
  risk: z.string().max(80),
  at: z.number().finite(),
  deadline: z.number().finite(),
  pid: z.number().int().positive(),
});

/**
 * 解析一个 pending 文件。文件名必须是它自己的 id；已经过了截止时间、
 * 截止时间比钩子能等的还长（对不上号），都不亮卡。
 */
export function parseAgentPermission(
  raw: unknown,
  fileId: string,
  now: number,
): AgentPermissionRequest | null {
  const parsed = pendingSchema.safeParse(raw);
  if (!parsed.success) return null;
  const data = parsed.data;
  if (data.id !== fileId) return null;
  if (data.deadline <= now) return null;
  if (data.deadline - data.at > remoteApproveLimits.maxWaitMs + 1_000) return null;
  return {
    id: data.id,
    fp: data.fp,
    source: data.src,
    tool: data.tool,
    cwd: data.cwd,
    detail: data.detail,
    keys: data.keys,
    risk: data.risk,
    at: data.at,
    deadline: data.deadline,
    pid: data.pid,
  };
}

const agentNames: Record<AgentPermissionSource, string> = {
  'claude-code': 'Claude Code',
  workbuddy: 'WorkBuddy',
};

function actionOf(tool: string): string {
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return '运行命令';
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return '改文件';
    case 'Write':
      return '写文件';
    case 'Read':
      return '读文件';
    case 'Glob':
    case 'Grep':
    case 'LS':
      return '查文件';
    case 'WebFetch':
      return '打开网页';
    case 'WebSearch':
      return '搜索网页';
    default:
      return `用 ${tool}`;
  }
}

export function projectName(cwd: string): string {
  const parts = cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] ?? '';
}

/** 卡片标题：「Claude Code 想运行命令 · xinban」；高风险的末尾标出风险。 */
export function agentPermissionTitle(request: AgentPermissionRequest): string {
  const project = projectName(request.cwd);
  const head = `${agentNames[request.source]} 想${actionOf(request.tool)}`;
  const titled = project ? `${head} · ${project}` : head;
  return request.risk ? `${titled} · ⚠${request.risk}` : titled;
}

/** 高风险、认不出、没有项目目录的，卡上永远没有「以后同类都批」。 */
export function canRemember(request: AgentPermissionRequest): boolean {
  return request.risk === '' && request.keys.length > 0 && request.cwd !== '';
}

/** 确认结果 → 写给钩子的决定。cancelled（钩子已经走了、芯伴退出）不写。 */
export function decisionFor(outcome: ConfirmOutcome): AgentDecision | null {
  switch (outcome) {
    case 'allowed':
    case 'remembered':
      return 'allow';
    case 'denied':
      return 'deny';
    case 'deferred':
    case 'expired':
      return 'defer';
    case 'cancelled':
      return null;
  }
}
