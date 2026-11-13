import { z } from 'zod';
import type { AiActionResult, AiConfigInput, AiStatus } from './ai';
import type { AiSessionState } from './ai-session';
import type { DelegateConfig, DelegateSnapshot } from './delegate';
import type { MemoryState } from './memory';
import type { MemoryTidyState } from './memory-tidy';
import type { PersonaConfig } from './persona';
import type { WorkProgressState } from './progress';
import type { AgentSourcesConfig } from './agent-logs';
import type { HookTarget, HooksStatus } from './hook-install';
import type { HookRepairConsent, HookWatchSnapshot } from './hook-watch';
import type { HealthSnapshot } from './app-log';
import type { FilesResult, FilesSnapshot } from './file-roots';
import type { AttachmentInfo } from './attachments';
import type { McpImportResult, McpResult, McpServerInput, McpSnapshot, McpTrust } from './mcp';
import type { ApprovalGrant, ApprovalView } from './auto-approve';
import type { RemoteApproveConfig } from './agent-permission';
import type { WorkbenchState } from './workbench';
import type { ReviewResult } from './review';
import type { PhonePushSaveInput, PhonePushView } from './phone-push';
import type { UsageWeekView } from './usage-stats';
import type { LanScanState } from './lan-scan';
import type { MusicSnapshot } from './music';
import type { IotConfig } from './iot';
import type { SensesConfig, SensesSnapshot } from './senses';
import type { SttSnapshot } from './stt';
import type { TtsSnapshot } from './tts';
import type { VisionConfig, VisionSnapshot } from './vision';
import type { VoiceConfig } from './voice';
import type { ConfirmSnapshot } from './confirm';
import type { ProactiveConfig, ProactiveSnapshot } from './proactive';
import type { DeviceConfig, DeviceSnapshot } from './device-protocol';

export type AttachResult = { ok: true; items: AttachmentInfo[] } | { ok: false; error: string };

export const sessionKindSchema = z.enum(['idle', 'coding', 'design', 'document', 'entertainment']);
export type SessionKind = z.infer<typeof sessionKindSchema>;
export const sessionLabels: Record<SessionKind, string> = {
  idle: '自由时光',
  coding: '编码',
  design: '设计',
  document: '文档办公',
  entertainment: '休息娱乐',
};

const id = z.string().min(1).max(128);
const title = z.string().trim().min(1).max(100);
const timestamp = z.number().finite().nonnegative();
export const taskStatusSchema = z.enum(['running', 'waiting', 'succeeded', 'failed', 'cancelled']);
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export const terminalStatuses: TaskStatus[] = ['succeeded', 'failed', 'cancelled'];
export const progressSchema = z
  .object({ completed: z.number().int().nonnegative(), total: z.number().int().positive() })
  .strict()
  .refine((value) => value.completed <= value.total, '完成数不能超过总数');

export const simulationEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    simulation: z.literal(true),
    eventId: id,
    sourceId: z.literal('local-simulator'),
    taskId: id,
    sequence: z.number().int().nonnegative(),
    title,
    status: taskStatusSchema,
    progress: progressSchema.optional(),
  })
  .strict();
export type SimulationEvent = z.infer<typeof simulationEventSchema>;

export const settingsSchema = z
  .object({
    alwaysOnTop: z.boolean(),
    quiet: z.boolean(),
    reducedMotion: z.boolean(),
    /** 面板里显示「模拟实验室」。开发调试用，默认藏起来；旧存档没有这一项。 */
    showLab: z.boolean().optional(),
  })
  .strict();
const timerSchema = z
  .object({
    id,
    status: z.enum(['running', 'paused', 'completed', 'recovery']),
    durationMs: z
      .number()
      .int()
      .positive()
      .max(180 * 60_000),
    remainingMs: z
      .number()
      .finite()
      .nonnegative()
      .max(180 * 60_000),
    startedAt: timestamp.nullable(),
    /** 进入「待确认」的原因：应用重启，或运行期检测到系统休眠／时间跳变。 */
    recoveryReason: z.enum(['restart', 'clock-jump']).nullish(),
  })
  .strict()
  .refine((timer) => timer.remainingMs <= timer.durationMs)
  .refine((timer) => (timer.status === 'running') === (timer.startedAt !== null))
  .refine((timer) => timer.status !== 'completed' || timer.remainingMs === 0);
// 旧版数据里的 recovery 计时没有 recoveryReason，读取时按「重启」处理，不做强制校验。
/** 到期时间：可选。上限十年，防止手工改文件写进一个永远不会到的天文数字。 */
const dueAt = z.number().int().nonnegative().max(4_102_444_800_000);
const todoSchema = z
  .object({ id, title, done: z.boolean(), createdAt: timestamp, dueAt: dueAt.optional() })
  .strict();

export const persistedSchema = z
  .object({
    version: z.literal(1),
    session: z.object({ kind: sessionKindSchema, title }).strict(),
    timer: timerSchema.nullable(),
    todos: z
      .array(todoSchema)
      .max(1_000)
      // 重复 id 会让「划掉一件」同时划掉好几件；手工改坏的文件在这里拦下。
      .refine(
        (todos) => new Set(todos.map((todo) => todo.id)).size === todos.length,
        '待办 id 重复',
      ),
    settings: settingsSchema,
  })
  .strict();
export type PersistedState = z.infer<typeof persistedSchema>;
export type Timer = NonNullable<PersistedState['timer']>;
export interface SimulatedTask {
  id: string;
  title: string;
  sequence: number;
  status: TaskStatus;
  progress?: z.infer<typeof progressSchema>;
  updatedAt: number;
}
export interface AppState extends PersistedState {
  revision: number;
  now: number;
  simulation: {
    connected: boolean;
    tasks: SimulatedTask[];
    seenIds: string[];
    journal: string[];
    /** F-12：最近到达的 30 个原始事件，用于导出／导入回放脚本，不持久化。 */
    events: SimulationEvent[];
  };
  petUntil: number;
}

export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.set'), kind: sessionKindSchema, title }).strict(),
  z.object({ type: z.literal('todo.add'), title, dueAt: dueAt.optional() }).strict(),
  z.object({ type: z.literal('todo.due'), id, dueAt: dueAt.nullable() }).strict(),
  z.object({ type: z.literal('todo.toggle'), id }).strict(),
  z.object({ type: z.literal('todo.remove'), id }).strict(),
  z.object({ type: z.literal('timer.start'), minutes: z.number().int().min(1).max(180) }).strict(),
  z.object({ type: z.literal('timer.pause') }).strict(),
  z.object({ type: z.literal('timer.resume') }).strict(),
  z.object({ type: z.literal('timer.cancel') }).strict(),
  z
    .object({ type: z.literal('settings.patch'), patch: settingsSchema.partial().strict() })
    .strict(),
  z.object({ type: z.literal('pet.interact') }).strict(),
  z.object({ type: z.literal('sim.connect'), connected: z.boolean() }).strict(),
  z.object({ type: z.literal('sim.event'), event: simulationEventSchema }).strict(),
  z.object({ type: z.literal('sim.acknowledge'), taskId: id }).strict(),
  z
    .object({
      type: z.literal('sim.script'),
      events: z.array(simulationEventSchema).min(1).max(30),
    })
    .strict(),
  z.object({ type: z.literal('sim.reset') }).strict(),
]);
export type Action = z.infer<typeof actionSchema>;
/** 只由主进程产生的内部动作；不在 IPC 的 actionSchema 里，renderer 无法伪造。 */
export type InternalAction =
  Action | { type: 'clock.tick' } | { type: 'timer.clock-jump'; jumpMs: number };

export interface Snapshot {
  state: AppState;
  storageError: string | null;
}
export type CommandResult = { ok: true; snapshot: Snapshot } | { ok: false; error: string };
export type ReplayCommandResult = { ok: true; applied: number } | { ok: false; error: string };
export interface CompanionBridge {
  snapshot(): Promise<Snapshot>;
  dispatch(action: Action): Promise<CommandResult>;
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
  windowAction(action: 'panel' | 'companion' | 'hide' | 'quit'): Promise<void>;
  /** 仅伙伴窗口可用：透明空白区穿透桌面点击。fire-and-forget，不暴露任意窗口操作。 */
  mousePassthrough(ignore: boolean): void;
  exportData(): Promise<{ ok: boolean; error?: string }>;
  importData(): Promise<CommandResult>;
  exportMapping(): Promise<{ ok: boolean; error?: string }>;
  exportReplay(): Promise<{ ok: boolean; error?: string }>;
  importReplay(): Promise<ReplayCommandResult>;
  clearData(): Promise<CommandResult>;
  aiStatus(): Promise<AiStatus>;
  aiConfigure(input: AiConfigInput): Promise<AiActionResult>;
  aiClear(): Promise<AiActionResult>;
  /** 当前对话。由主进程持有，桌宠窗口与控制面板共享同一份。 */
  aiSession(): Promise<AiSessionState>;
  /** 发起一轮对话。过程与结果通过 onAiSession 推送，不在这里重复返回正文。 */
  /** attachments：attachPick/attachPaths 返回的 id。 */
  aiSend(text: string, attachments?: string[]): Promise<AiActionResult>;
  /** 弹系统文件选择窗，选中的文件复制进沙盒 uploads/。 */
  attachPick(): Promise<AttachResult>;
  /** 拖进来的文件（路径由 pathForFile 取得）复制进沙盒 uploads/。 */
  attachPaths(paths: string[]): Promise<AttachResult>;
  /** 拖放事件里的 File → 本机路径（Electron webUtils）。 */
  pathForFile(file: File): string;
  /** 订阅对话变化（含流式增量）；两个窗口都可用，是桌宠能回话的前提。 */
  onAiSession(listener: (state: AiSessionState) => void): () => void;
  aiCancel(): Promise<void>;
  /** 停下后台正在干的派活（对话不受影响）。 */
  delegateCancel(): Promise<void>;
  /**
   * 长期记忆：只存在本机，面板里可查看、逐条删除、整体清空、一键关闭。
   * 关闭后不再注入、不再抽取，记忆类工具也会从工具表里撤掉。
   */
  memoryState(): Promise<MemoryState>;
  memoryRemove(id: string): Promise<AiActionResult>;
  memoryClear(): Promise<AiActionResult>;
  memoryEnable(enabled: boolean): Promise<AiActionResult>;
  onMemoryState(listener: (state: MemoryState) => void): () => void;
  /**
   * 记忆整理：只有面板能发起。模型只出方案，用户勾选后才应用；应用前自动备份，可撤销。
   */
  memoryTidyState(): Promise<MemoryTidyState>;
  memoryTidyStart(): Promise<MemoryTidyState>;
  memoryTidyApply(actionIds: string[]): Promise<MemoryTidyState>;
  memoryTidyDiscard(): Promise<MemoryTidyState>;
  memoryTidyUndo(): Promise<MemoryTidyState>;
  onMemoryTidyState(listener: (state: MemoryTidyState) => void): () => void;
  /**
   * 性格：预设 + 昵称。只影响提示词，不影响任何权限判断。
   * 从面板改，小屏上不给入口——误触换性格比误触删记忆更烦人。
   */
  personaState(): Promise<PersonaConfig>;
  /** 只改传来的那几项，其余保持。 */
  personaSave(config: Partial<PersonaConfig>): Promise<AiActionResult>;
  onPersonaState(listener: (config: PersonaConfig) => void): () => void;
  /**
   * 工作进度：读本机上另一个窗口（WorkBuddy）的会话记录。
   * 只读、只在本机，用来回答「我那个弄到哪了」。看不到时返回空列表，不报错。
   */
  workState(): Promise<WorkProgressState>;
  workRefresh(): Promise<WorkProgressState>;
  workSourcesSave(config: AgentSourcesConfig): Promise<{ ok: boolean; error?: string }>;
  /** 官方通知钩子：只有面板能看、能装卸；会改用户自己的 Claude Code / Codex 配置。 */
  hooksStatus(): Promise<HooksStatus>;
  hooksApply(
    target: HookTarget,
    action: 'install' | 'uninstall',
  ): Promise<{ ok: true; status: HooksStatus } | { ok: false; error: string }>;
  /** 钩子自检：装过的钩子被拆了就报；同意重装一次后自动。只有面板能用。 */
  hooksWatchState(): Promise<HookWatchSnapshot | null>;
  hooksRepair(): Promise<{ ok: boolean; error?: string }>;
  hooksConsent(consent: HookRepairConsent): Promise<{ ok: boolean; error?: string }>;
  onHooksWatch(listener: (snapshot: HookWatchSnapshot) => void): () => void;
  /** 运行健康：本次启动的告警/错误与日志目录。只有面板能用。 */
  health(): Promise<HealthSnapshot | null>;
  healthOpenLogs(): Promise<{ ok: boolean; error?: string }>;
  onHealth(listener: (health: HealthSnapshot) => void): () => void;
  /** 授权目录与文件改动：加目录、开写权限、撤销都只有面板能做。 */
  filesState(): Promise<FilesSnapshot>;
  /** 不传路径就弹系统的选目录窗。 */
  filesAdd(path: string | null, writable: boolean): Promise<FilesResult>;
  filesRemove(name: string): Promise<FilesResult>;
  filesWritable(name: string, writable: boolean): Promise<FilesResult>;
  filesUndo(id: string): Promise<FilesResult>;
  onFiles(listener: (snapshot: FilesSnapshot) => void): () => void;
  /** 外接 MCP 服务器：只有面板能看、能改；快照里没有密钥值。 */
  mcpState(): Promise<McpSnapshot>;
  mcpSave(input: McpServerInput): Promise<McpResult>;
  mcpRemove(name: string): Promise<McpResult>;
  mcpEnable(name: string, enabled: boolean): Promise<McpResult>;
  mcpTrust(name: string, trust: McpTrust): Promise<McpResult>;
  /** trust 为 null：跟整台。 */
  mcpToolTrust(name: string, tool: string, trust: McpTrust | null): Promise<McpResult>;
  mcpRestart(name: string): Promise<McpResult>;
  mcpImport(source: 'claude-code' | 'claude-desktop'): Promise<McpImportResult>;
  onMcp(listener: (snapshot: McpSnapshot) => void): () => void;
  /** 替你确认：只有面板能看、能开关、能撤销；「学会」只来自你在对方弹窗里的批准。 */
  approvalsState(): Promise<ApprovalView>;
  approvalsEnable(
    enabled: boolean,
  ): Promise<{ ok: true; view: ApprovalView } | { ok: false; error: string }>;
  approvalsRevoke(
    grant: Pick<ApprovalGrant, 'source' | 'project' | 'key'>,
  ): Promise<{ ok: true; view: ApprovalView } | { ok: false; error: string }>;
  /** 工作台：谁在等我。两边都能看、标已看；看改动/打开编辑器/改编辑器只有面板。 */
  workbenchState(): Promise<WorkbenchState | null>;
  workbenchSeen(key: string): Promise<{ ok: boolean; error?: string }>;
  workbenchReview(key: string): Promise<ReviewResult | null>;
  workbenchDiff(
    key: string,
  ): Promise<{ ok: true; text: string; truncated: boolean } | { ok: false; error: string }>;
  workbenchOpen(key: string): Promise<{ ok: boolean; error?: string }>;
  workbenchEditor(editor: string): Promise<{ ok: boolean; error?: string }>;
  onWorkbench(listener: (state: WorkbenchState) => void): () => void;
  /** 推到手机：只有面板。地址与密钥只进不出。 */
  phonePushState(): Promise<PhonePushView | null>;
  phonePushSave(
    input: PhonePushSaveInput,
  ): Promise<{ ok: true; view: PhonePushView } | { ok: false; error: string }>;
  phonePushTest(): Promise<{ ok: boolean; error?: string }>;
  /** 自用计数：本周与上周，只有面板。 */
  usageState(): Promise<UsageWeekView[] | null>;
  /** 家庭设备普查：只有面板能发起、能看；只读扫本机所在的局域网。 */
  lanScanState(): Promise<LanScanState | null>;
  lanScanStart(subnet: string): Promise<{ ok: true } | { ok: false; error: string }>;
  onLanScan(listener: (state: LanScanState) => void): () => void;
  /** 远程批准：开关与等待时长，只有面板能看、能改。 */
  remoteApproveState(): Promise<RemoteApproveConfig | null>;
  remoteApproveSave(
    config: RemoteApproveConfig,
  ): Promise<{ ok: true; config: RemoteApproveConfig } | { ok: false; error: string }>;
  onWorkState(listener: (state: WorkProgressState) => void): () => void;
  /**
   * 耳朵与眼睛：三个开关存在本机，采集只在桌宠窗口发生。
   * 麦克风只算音量、摄像头只算帧差——这条桥上没有画面、没有音频、没有文字。
   */
  sensesState(): Promise<SensesSnapshot>;
  sensesSave(config: SensesConfig): Promise<AiActionResult>;
  /** 采集端上报读数。fire-and-forget：高频，不该等回包。 */
  sensesReport(reading: Partial<SensesSnapshot['reading']>): void;
  onSensesState(listener: (snapshot: SensesSnapshot) => void): () => void;
  /**
   * 语音包：配置「怎么念」——嗓子来源、预设、音色、语速、音调。
   *
   * 配置本身不走音频。真正出声有两条路：`voice` 让渲染进程用系统语音念（离线、不出本机），
   * `ttsSpeak` 让主进程合成一段 mp3 回来（更像真人，但要 Key、要联网）。
   */
  voiceState(): Promise<VoiceConfig>;
  voiceSave(config: VoiceConfig): Promise<AiActionResult>;
  onVoiceState(listener: (config: VoiceConfig) => void): () => void;
  /**
   * 云端合成一段语音。文本出本机，音频只在内存里过一趟、不落盘。
   * Key 与语音转写共用同一份，主进程解密，渲染进程看不到。
   */
  ttsState(): Promise<TtsSnapshot>;
  ttsStop(): Promise<void>;
  sttStop(): Promise<void>;
  ttsSpeak(input: {
    text: string;
    voice: string;
    speed: number;
    gain: number;
  }): Promise<{ ok: boolean; audio?: ArrayBuffer; mime?: string; error?: string }>;
  onTtsState(listener: (snapshot: TtsSnapshot) => void): () => void;
  /**
   * 语音转文字。和耳朵是两件事：耳朵只算音量，这条才会把声音变成字。
   *
   * 只有桌宠窗口能调——录音在那里发生，Key 在主进程解密，音频不落盘。
   */
  sttState(): Promise<SttSnapshot>;
  sttSave(input: { enabled: boolean }): Promise<AiActionResult>;
  sttSaveKey(input: { apiKey: string }): Promise<AiActionResult>;
  sttClearKey(): Promise<AiActionResult>;
  /** 传一段录好的音频，拿回文字。音频只在内存里过一趟。 */
  sttTranscribe(
    audio: ArrayBuffer,
    mime: string,
  ): Promise<{ ok: boolean; text?: string; error?: string }>;
  onSttState(listener: (snapshot: SttSnapshot) => void): () => void;
  /**
   * 视觉：把一帧画面交给视觉模型，换回一段文字描述。
   *
   * 这条桥上没有像素上行到渲染层，也没有像素落在磁盘：图从设备到主进程，
   * 编码成 base64 发出去就丢。渲染进程只能看到「描述」。
   */
  visionState(): Promise<VisionSnapshot>;
  visionSave(config: VisionConfig): Promise<AiActionResult>;
  /** 面板里「看一眼」：立刻截一帧并描述。工具调用走主进程内部，不经过这条。 */
  visionLook(input: { source: 'screen' | 'camera'; question?: string }): Promise<{
    ok: boolean;
    text?: string;
    error?: string;
  }>;
  onVisionState(listener: (snapshot: VisionSnapshot) => void): () => void;
  /**
   * 派活与命令：把活交给本机的 AI Agent，或授权后跑系统命令。
   *
   * 两个开关都默认关，只能从面板打开——这是本项目里第一次把「动手权」交出去，
   * 授权必须是一次明确的动作，而不是对话里随口一句。
   */
  delegateState(): Promise<DelegateSnapshot>;
  delegateSave(config: DelegateConfig): Promise<AiActionResult>;
  /** 重新探测命令装没装（面板按钮）。 */
  delegateProbe(): Promise<DelegateSnapshot>;
  onDelegateState(listener: (snapshot: DelegateSnapshot) => void): () => void;
  /** 主进程要摄像头画面时回调；拍完用 sendCameraFrame 回传。只有桌宠窗口会收到。 */
  onCaptureFrame(listener: (requestId: string) => void): () => void;
  /** 回传连拍的帧数组；空数组表示「没拍到」。 */
  sendCameraFrame(
    requestId: string,
    frames: { bytes: ArrayBuffer; width: number; height: number; capturedAt?: number }[],
  ): void;
  /** 用系统默认浏览器打开来源链接；渲染进程自身不允许导航。 */
  openExternal(url: string): Promise<{ ok: boolean; error?: string }>;
  /**
   * 逐次确认：它想跑命令、看屏幕/摄像头、派活时先问你。
   * 两个窗口都能看、都能答；实体按键在主进程里走同一个入口。
   */
  confirmState(): Promise<ConfirmSnapshot>;
  confirmAnswer(id: string, allow: boolean): Promise<{ ok: boolean; error?: string }>;
  /** 外部 Agent 卡片：交回终端 / 允许并以后同类都批。 */
  confirmExternal(
    id: string,
    action: 'defer' | 'remember',
  ): Promise<{ ok: boolean; error?: string }>;
  onConfirmState(listener: (snapshot: ConfirmSnapshot) => void): () => void;
  /** 主动开口：屏上那张卡、最近说过的话、关系账本。设置只在面板改。 */
  proactiveState(): Promise<ProactiveSnapshot>;
  proactiveAnswer(
    id: string,
    answer: 'accept' | 'dismiss',
  ): Promise<{ ok: boolean; error?: string }>;
  proactiveSave(config: ProactiveConfig): Promise<{ ok: boolean; error?: string }>;
  onProactiveState(listener: (snapshot: ProactiveSnapshot) => void): () => void;
  /**
   * 音乐：控制电脑上已开着的音乐客户端。musicState 只读快照不启动任何东西；
   * musicRefresh / musicControl 是用户动作，第一次调用时才拉起系统媒体桥。
   */
  musicState(): Promise<MusicSnapshot>;
  musicRefresh(): Promise<{ ok: true; snapshot: MusicSnapshot } | { ok: false; error: string }>;
  musicControl(
    command: 'toggle' | 'next' | 'prev',
  ): Promise<{ ok: true; snapshot: MusicSnapshot } | { ok: false; error: string }>;
  onMusicState(listener: (snapshot: MusicSnapshot) => void): () => void;
  /** 实体设备（ESP32 小屏）：状态两边可读，启用与端口只在面板改。 */
  deviceState(): Promise<DeviceSnapshot>;
  deviceSave(config: DeviceConfig): Promise<{ ok: boolean; error?: string }>;
  /** 物联网：登记设备、开关设备。都只在面板里、由用户点击触发。 */
  iotSave(config: IotConfig): Promise<{ ok: boolean; error?: string }>;
  iotSet(id: string, on: boolean): Promise<{ ok: boolean; error?: string }>;
  deviceRefresh(): Promise<DeviceSnapshot>;
  /** 模拟设备的按键（只在模拟模式下生效）。 */
  deviceSimPress(button: 'A' | 'B', edge: 'down' | 'up'): Promise<{ ok: boolean }>;
  onDeviceState(listener: (snapshot: DeviceSnapshot) => void): () => void;
}
