import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
  type IpcMainInvokeEvent,
} from 'electron';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { inputMappingReport } from '../core/input';
import { intentFor, type GestureIntent } from '../core/gesture';
import { buildDeviceView } from '../core/device-view';
import { faceOf } from '../core/expression';
import { lastExchange } from '../core/ai-session';
import { petExcerpt } from '../core/persona';
import { shortActivity, type WorkProgressState } from '../core/progress';
import { detectWorkNudges, dueTodoNudges } from '../core/nudge-sources';
import { ConfirmService } from './confirm';
import { ProactiveService } from './proactive';
import { DeviceService, SerialConnector, SimulatedDevice } from './device';
import { parseReplayScript, replayFileLimit, replayScriptText } from '../core/replay';
import { durableState } from '../core/state';
import { sensesPrompt, sensesText } from '../core/senses';
import { sttPrompt } from '../core/stt';
import { JsonStore } from './store';
import { StateService } from './service';
import { AiService } from './ai';
import { AiSessionService } from './ai-session';
import { ToolExecutor } from './tools';
import { AudioService } from './audio';
import { ElectronAudioPlayer } from './audio-player';
import { MusicService, PowerShellMediaBridge } from './music';
import { MemoryService, MemoryStore } from './memory';
import { MemoryTidyService } from './memory-tidy';
import { PersonaService, PersonaStore } from './persona';
import { SensesService, SensesStore } from './senses';
import { VoiceService, VoiceStore } from './voice';
import { SttConfigStore, SttService } from './stt';
import { TtsService } from './tts';
import { VisionService, VisionStore } from './vision';
import { createVisionCapture } from './capture';
import { visionPrompt } from '../core/vision';
import { DelegateService, DelegateStore } from './delegate';
import { delegatePrompt, delegateReport, type DelegateRunResult } from '../core/delegate';
import {
  CodexProgressSource,
  FsProgressSource,
  MultiProgressSource,
  ProgressService,
  type ProgressSource,
} from './progress';
import { normalizeAgentSources, type AgentSourcesConfig } from '../core/agent-logs';
import { isHookTarget } from '../core/hook-install';
import { HookInbox, HookInstaller, defaultHookPaths, hooksDir, inboxDir, inboxPath } from './hooks';
import { HookWatchService } from './hook-watch';
import { AppLog, errorText } from './app-log';
import { FileAccessService } from './files';
import { AttachmentService } from './attachments';
import { McpService, defaultChannelFactory } from './mcp';
import { mcpLimits, mcpPrompt } from '../core/mcp';
import { z } from 'zod';
import { attachmentLine, attachmentPrompt } from '../core/attachments';
import { wrapUntrusted } from '../core/agent';
import { fileRootsPrompt } from '../core/file-roots';
import { lostText } from '../core/hook-watch';
import { ApprovalStore } from './approvals';
import { AgentPermissionBridge } from './agent-permission';
import { gitBaseline, WorkbenchService } from './workbench';
import { LanScanService } from './lan-scan';
import { longWaitNudges } from '../core/workbench';
import { PhonePushService } from './phone-push';
import { UsageService } from './usage-stats';
import { isWaitChoice } from '../core/agent-permission';
import { writeJsonAtomic } from './atomic';
import { AiCredentialStore, type AiCrypto } from './ai-credentials';
import {
  WindowBoundsStore,
  boundsOf,
  clampBounds,
  type Rectangle,
  type WindowBounds,
} from './window-bounds';

const development = process.env.XINBAN_DEV === '1';
/** 紧凑桌面宠物窗口尺寸；完整开发板装配只留在控制面板预览。 */
const PET_WIDTH = 264;
const PET_HEIGHT = 330;
if (process.env.XINBAN_DATA_DIR) app.setPath('userData', process.env.XINBAN_DATA_DIR);
app.setName('芯伴');
const windows = new Map<BrowserWindow, string>();
let panel: BrowserWindow;
let companion: BrowserWindow;
let tray: Tray | null = null;
let service: StateService;
let aiService: AiService;
let aiSession: AiSessionService;
let memoryService: MemoryService;
let memoryTidy: MemoryTidyService;
let personaService: PersonaService;
let sensesService: SensesService;
let voiceService: VoiceService;
let sttService: SttService;
let ttsService: TtsService;
let visionService: VisionService;
let delegateService: DelegateService;
/** 后台正在干的派活：和对话的取消分开，只有「停下」按钮和退出会止住它。 */
let delegateJob: AbortController | null = null;
let audioService: AudioService;
let audioPlayer: ElectronAudioPlayer;
let musicService: MusicService;
let progressService: ProgressService;
let agentSources: AgentSourcesConfig = normalizeAgentSources(null);
let agentSourcesPath = '';
let hookInstaller: HookInstaller;
let hookWatch: HookWatchService | undefined;
let appLog: AppLog | undefined;
let fileAccess: FileAccessService | undefined;
let mcpService: McpService | undefined;
let approvalStore: ApprovalStore | undefined;
let agentPermissions: AgentPermissionBridge | undefined;
/** 工作台：谁在等我 / 出错 / 干完没看 / 在干。 */
let workbench: WorkbenchService | undefined;
let workbenchTimer: ReturnType<typeof setInterval> | undefined;
/** 离开电脑时推到手机（飞书群机器人）。 */
let phonePush: PhonePushService | undefined;
/** 自用两周的四个计数：只记次数和时长。 */
let usage: UsageService | undefined;
let lanScan: LanScanService | undefined;
/** 进度快照里带上「盯哪些 agent」的开关，面板和桌宠看到的是同一份。 */
function withSources(state: WorkProgressState): WorkProgressState {
  return { ...state, sources: agentSources };
}
let confirmService: ConfirmService;
let proactiveService: ProactiveService;
let deviceService: DeviceService;
const simulatedDevice = new SimulatedDevice();
let ticker: ReturnType<typeof setInterval> | undefined;
/** 最近一次用户主动操作的时刻：早安/收工/久别重逢挂在「人来了」上。 */
let lastTouchAt = 0;
/** 最近一次 AI 回复定稿的时刻：实体屏只在之后一小段时间里显示那句回复。 */
let replyShownAt = 0;
let quitting = false;
let quitReady = false;
let boundsStore: WindowBoundsStore;
let pendingBounds: WindowBounds | null = null;
let boundsTimer: ReturnType<typeof setTimeout> | undefined;
let boundsQueue: Promise<void> = Promise.resolve();

function queueBoundsWrite(value: WindowBounds): void {
  boundsQueue = boundsQueue.then(() => boundsStore.save(value)).catch(() => undefined);
}

/** 拖动时防抖写盘；连续移动只保留最后一次位置，退出前会 flush。 */
function rememberBounds(window: BrowserWindow): void {
  pendingBounds = boundsOf(window.getBounds());
  if (boundsTimer !== undefined) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    boundsTimer = undefined;
    if (pendingBounds) {
      const value = pendingBounds;
      pendingBounds = null;
      queueBoundsWrite(value);
    }
  }, 300);
}

async function settleBounds(): Promise<void> {
  if (boundsTimer !== undefined) {
    clearTimeout(boundsTimer);
    boundsTimer = undefined;
  }
  if (pendingBounds) {
    const value = pendingBounds;
    pendingBounds = null;
    queueBoundsWrite(value);
  }
  await boundsQueue;
}

/** 广播到所有应用窗口。 */
function broadcast(channel: string, payload: unknown): void {
  for (const window of windows.keys()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

/**
 * 你来了。一分钟最多算一次：鼠标划过桌宠、点了按钮、发了消息都算。
 * 早安/收工/久别重逢从这里冒出来，而不是定时器到点就对着空房间说话。
 */
function touchPresence(): void {
  if (!proactiveService || !service) return;
  const now = Date.now();
  if (now - lastTouchAt < 60_000) return;
  lastTouchAt = now;
  const open = service.snapshot().state.todos.filter((todo) => !todo.done).length;
  proactiveService.touch(open);
}

function verify(event: IpcMainInvokeEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (
    !window ||
    event.senderFrame !== event.sender.mainFrame ||
    event.senderFrame.url !== windows.get(window)
  ) {
    throw new Error('不允许的消息来源。');
  }
  return window;
}

/** AI 会消耗账户额度，只允许控制面板主动发起；桌宠窗口不提供输入入口。 */
function verifyPanel(event: IpcMainInvokeEvent): BrowserWindow {
  const window = verify(event);
  if (window !== panel) throw new Error('AI 操作只能从控制面板发起。');
  return window;
}

/** 转录只接受桌宠窗口的请求：音频在那里录，面板根本没有麦克风权限。 */
function verifyPet(event: IpcMainInvokeEvent): BrowserWindow {
  const window = verify(event);
  if (window !== companion) throw new Error('录音只能从桌宠窗口发起。');
  return window;
}

/**
 * 摄像头与麦克风的唯一投放点。
 *
 * 之前的版本无条件 `callback(false)`，任何窗口都拿不到媒体权限——这是对的默认值，
 * 但也就等于「没有耳朵眼睛」。现在只放开一条缝，且三条都成立才放行：
 *
 * 1. 请求来自我们自己的页面（`file:` 下的 index.html，或开发时的本地 5173）；
 * 2. 请求来自**桌宠窗口**，面板与将来的任何窗口都拿不到；
 * 3. 用户已经在面板里打开了对应通道。
 *
 * 第 3 条要在这里查而不是只靠界面隐藏按钮：界面是渲染进程，
 * 渲染进程被注入时按钮状态是可以被改的，权限判断必须在主进程。
 */
function appPageUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'file:') return url.pathname.endsWith('/index.html');
    return (
      development && url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === '5173'
    );
  } catch {
    return false;
  }
}

function mediaAllowed(contents: Electron.WebContents | null): boolean {
  if (!contents || !companion || companion.isDestroyed()) return false;
  if (contents !== companion.webContents) return false;
  return appPageUrl(contents.getURL());
}

/** 面板里打开开关时，macOS 还要走一次系统级授权；Windows 由系统隐私设置管。 */
async function askMediaAccess(config: { ears: boolean; eyes: boolean }): Promise<void> {
  if (process.platform !== 'darwin') return;
  try {
    if (config.ears) await systemPreferences.askForMediaAccess('microphone');
    if (config.eyes) await systemPreferences.askForMediaAccess('camera');
  } catch {
    // 用户拒绝或系统不支持：真正的结果由采集端上报，这里不拦。
  }
}

function show(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  // 重新显示时恢复可交互，避免上次停在透明区时窗口处于穿透状态。
  if (window === companion) companion.setIgnoreMouseEvents(false, { forward: true });
}

function createWindow(
  role: 'panel' | 'companion',
  savedBounds: WindowBounds | null,
): BrowserWindow {
  const pet = role === 'companion';
  const area = screen.getPrimaryDisplay().workArea;
  const fallback: Rectangle = {
    x: area.x + area.width - PET_WIDTH - 24,
    y: area.y + area.height - PET_HEIGHT - 20,
    width: PET_WIDTH,
    height: PET_HEIGHT,
  };
  const rect = clampBounds(
    savedBounds,
    screen.getAllDisplays().map((display) => display.workArea),
    fallback,
  );
  const window = new BrowserWindow({
    width: pet ? rect.width : Math.min(1160, area.width),
    height: pet ? rect.height : Math.min(830, area.height),
    ...(pet ? { x: rect.x, y: rect.y } : {}),
    minWidth: pet ? PET_WIDTH : 720,
    minHeight: pet ? PET_HEIGHT : 600,
    transparent: pet,
    frame: !pet,
    resizable: !pet,
    maximizable: !pet,
    hasShadow: !pet,
    backgroundColor: pet ? '#00000000' : '#f5f4ef',
    title: pet ? '芯伴 · 桌面伙伴' : '芯伴 · 控制面板',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      backgroundThrottling: true,
    },
  });
  const url = new URL(
    development
      ? 'http://127.0.0.1:5173/'
      : pathToFileURL(join(__dirname, '../renderer/index.html')).href,
  );
  url.searchParams.set('window', role);
  windows.set(window, url.href);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('closed', () => windows.delete(window));
  if (pet) {
    // Windows 触发 move，macOS 触发 moved；两处都监听，防抖写盘会合并。
    window.on('move', () => rememberBounds(window));
    window.on('moved', () => rememberBounds(window));
  }
  window.once('ready-to-show', () => {
    // 启动只显示桌面伙伴；控制面板收在托盘，由用户主动打开。
    if (pet) window.show();
  });
  void window.loadURL(url.href).catch((error: unknown) => {
    dialog.showErrorBox('芯伴无法启动', String(error));
    app.quit();
  });
  return window;
}

async function start(): Promise<void> {
  // 运行日志：只记发生了什么（事件、耗时、错误摘要），不记对话内容与密钥。
  const log = new AppLog(join(app.getPath('userData'), 'logs'), app.getVersion());
  appLog = log;
  log.info('app-start', {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
  });
  // 只旁听不接管：用 Monitor 版本，不改变未捕获异常原来的处理方式。
  process.on('uncaughtExceptionMonitor', (error) =>
    log.error('uncaught', { error: errorText(error) }),
  );
  process.on('unhandledRejection', (reason) =>
    log.error('unhandled-rejection', { error: errorText(reason) }),
  );
  app.on('render-process-gone', (_event, _contents, details) =>
    log.error('renderer-gone', { reason: details.reason, code: details.exitCode }),
  );
  app.on('child-process-gone', (_event, details) =>
    log.warn('child-gone', { type: details.type, reason: details.reason, code: details.exitCode }),
  );
  log.subscribe((health) => {
    if (panel && !panel.isDestroyed()) panel.webContents.send('companion:health', health);
  });
  // 除了摄像头/麦克风这一项，其余权限（定位、通知、剪贴板、MIDI…）继续一律拒绝。
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission !== 'media' || !mediaAllowed(contents)) return callback(false);
    const types =
      'mediaTypes' in details && Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    const config = sensesService?.snapshot().config;
    // 麦克风现在有两条独立用途：常开的「只听音量」和按住说话的「转成文字」。
    // 任何一条打开都得放行，否则用户开了语音输入、按钮却按不动。
    const audioWanted = config?.ears === true || sttService?.snapshot().config.enabled === true;
    // 双保险：就算渲染进程请求了没打开的通道，也在这里按开关拒绝。
    // 摄像头也有两条用途：常开的「只看有没有人动」和 look 工具的单帧取像。
    // 只按 eyes 一个开关判断会漏掉后者——用户允许了「看画面」却死活拍不到。
    const videoWanted =
      config?.eyes === true || visionService?.snapshot().config.allowCamera === true;
    if (types.includes('audio') && !audioWanted) return callback(false);
    if (types.includes('video') && !videoWanted) return callback(false);
    callback(true);
  });
  // 同步检查必须跟着放行，否则 enumerateDevices 返回空列表，
  // 采集端连「有没有设备」都判断不了，只能永远报错。
  session.defaultSession.setPermissionCheckHandler(
    (contents, permission) => permission === 'media' && mediaAllowed(contents),
  );
  session.defaultSession.on('will-download', (event) => event.preventDefault());
  // Reject remote resources even if a renderer is tricked into requesting one.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    const localDev =
      development &&
      ['http:', 'ws:'].includes(url.protocol) &&
      url.hostname === '127.0.0.1' &&
      url.port === '5173';
    callback({ cancel: !['file:', 'data:', 'devtools:'].includes(url.protocol) && !localDev });
  });
  const wallAnchor = Date.now();
  const monotonicAnchor = performance.now();
  service = new StateService(
    new JsonStore(join(app.getPath('userData'), 'state-v1.json')),
    () => wallAnchor + performance.now() - monotonicAnchor,
  );
  await service.initialize();
  boundsStore = new WindowBoundsStore(join(app.getPath('userData'), 'window-bounds-v1.json'));
  const savedBounds = await boundsStore.load();
  const aiCrypto: AiCrypto = {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (payload) => safeStorage.decryptString(payload),
  };
  aiService = new AiService(
    new AiCredentialStore(join(app.getPath('userData'), 'ai-credentials-v1.json'), aiCrypto),
    fetch,
  );
  // 长期记忆：独立文件，独立生命周期。关掉它不影响对话，只是不再「记得」。
  memoryService = new MemoryService(
    new MemoryStore(join(app.getPath('userData'), 'memory-v1.json')),
  );
  await memoryService.init();
  memoryService.subscribe((state) => {
    for (const window of windows.keys()) {
      if (!window.isDestroyed()) window.webContents.send('companion:memory-state', state);
    }
  });
  memoryTidy = new MemoryTidyService(memoryService, aiService);
  await memoryTidy.init();
  memoryTidy.subscribe((state) => {
    // 整理方案里有记忆原文，只发给控制面板。
    if (panel && !panel.isDestroyed()) panel.webContents.send('companion:memory-tidy-state', state);
  });
  // 性格：预设 + 昵称，存在本机。它只影响提示词，不参与任何权限判断。
  personaService = new PersonaService(
    new PersonaStore(join(app.getPath('userData'), 'persona-v1.json')),
  );
  await personaService.init();
  personaService.subscribe((config) => {
    for (const window of windows.keys()) {
      if (!window.isDestroyed()) window.webContents.send('companion:persona-state', config);
    }
  });
  // 耳朵与眼睛：开关存在本机；采集在桌宠窗口做，读数回到这里再广播。
  // 权限处理器要读这份开关，所以必须在创建窗口之前 init 完。
  sensesService = new SensesService(
    new SensesStore(join(app.getPath('userData'), 'senses-v1.json')),
  );
  await sensesService.init();
  sensesService.subscribe((snapshot) => {
    for (const window of windows.keys()) {
      if (!window.isDestroyed()) window.webContents.send('companion:senses-state', snapshot);
    }
  });
  // 语音包：只存「怎么念」。音色列表在各渲染进程里（speechSynthesis），
  // 主进程不接触音频，所以这里没有权限问题，也不用等系统授权。
  voiceService = new VoiceService(new VoiceStore(join(app.getPath('userData'), 'voice-v1.json')));
  await voiceService.init();
  voiceService.subscribe((config) => {
    for (const window of windows.keys()) {
      if (!window.isDestroyed()) window.webContents.send('companion:voice-state', config);
    }
  });
  // 语音转文字：和耳朵是两件事。开关存一份，Key 单独加密存另一份（不同厂商、不同额度）。
  // 它必须在创建窗口之前 init 完——权限处理器要读这份开关才能决定给不给麦克风。
  const sttCredentialPath = join(app.getPath('userData'), 'stt-credentials-v1.json');
  sttService = new SttService(
    new SttConfigStore(join(app.getPath('userData'), 'stt-v1.json')),
    new AiCredentialStore(sttCredentialPath, aiCrypto),
    fetch,
  );
  await sttService.init();
  // 语音合成走硅基流动 CosyVoice2，和语音转文字共用同一把 Key（同一家厂商）。
  ttsService = new TtsService(new AiCredentialStore(sttCredentialPath, aiCrypto), fetch);
  await ttsService.init();
  ttsService.subscribe((snapshot) => {
    for (const window of windows.keys()) {
      if (!window.isDestroyed()) window.webContents.send('companion:tts-state', snapshot);
    }
  });
  sttService.subscribe((snapshot) => {
    for (const window of windows.keys()) {
      if (!window.isDestroyed()) window.webContents.send('companion:stt-state', snapshot);
    }
    // Key 存了或清了：合成与视觉共用这把 Key，跟着刷新。
    void ttsService.refresh();
    void visionService.refresh();
  });
  // 视觉：DeepSeek 是纯文本模型，看不见像素。这里单独接一层视觉模型，只负责把
  // 「一帧画面」转成一段文字，推理仍然交给 DeepSeek——分工不同，不能混为一谈。
  // 两路默认都关：截屏是侵入性能力，必须用户在面板里显式允许。
  // 摄像头帧由桌宠窗口拍（只有它有设备权限），所以这里拿的是窗口的惰性引用。
  visionService = new VisionService(
    new VisionStore(join(app.getPath('userData'), 'vision-v1.json')),
    new AiCredentialStore(sttCredentialPath, aiCrypto),
    fetch,
    createVisionCapture(() => companion),
  );
  await visionService.init();
  visionService.subscribe((snapshot) => {
    for (const window of windows.keys()) {
      if (!window.isDestroyed()) window.webContents.send('companion:vision-state', snapshot);
    }
  });
  // 工作进度：只读各 agent 落在本机的会话记录，定期扫，变化才广播。
  // WorkBuddy 默认开（原有行为）；Claude Code / Codex 默认关，面板里开——它们的对话摘要
  // 会随进度进入你问它的那句话（出站），得你同意。
  // 目录可用 XINBAN_PROJECTS_DIR / XINBAN_CLAUDE_DIR / XINBAN_CODEX_DIR 覆盖（测试用）。
  agentSourcesPath = join(app.getPath('userData'), 'agent-sources-v1.json');
  try {
    agentSources = normalizeAgentSources(JSON.parse(await readFile(agentSourcesPath, 'utf8')));
  } catch {
    agentSources = normalizeAgentSources(null);
  }
  const workbuddySource = new FsProgressSource(process.env.XINBAN_PROJECTS_DIR || undefined);
  const claudeSource = new FsProgressSource(
    process.env.XINBAN_CLAUDE_DIR || join(app.getPath('home'), '.claude', 'projects'),
    'claude-code',
  );
  const codexSource = new CodexProgressSource(
    process.env.XINBAN_CODEX_DIR || join(app.getPath('home'), '.codex', 'sessions'),
  );
  // 官方通知钩子：用户在面板里点「安装」后，Claude Code / Codex 会把状态事件写进收件箱。
  // 收件箱只有状态、没有对话内容，所以不受上面「读日志」开关约束；装钩子本身就是同意。
  // 钩子脚本随构建复制到 main.cjs 旁边（scripts/build-desktop.mjs）。
  hookInstaller = new HookInstaller(
    defaultHookPaths(app.getPath('userData'), join(__dirname, 'xinban-hook.cjs')),
  );
  // 升级后已装的脚本副本可能还是旧规则：先刷新，再让「替你确认」开始工作。
  await hookInstaller.refreshScript();
  // 替你确认：从收件箱学你批过什么；心跳告诉钩子「芯伴开着」。
  approvalStore = new ApprovalStore(hooksDir(app.getPath('userData')));
  await approvalStore.load();
  approvalStore.start();
  const approvals = approvalStore;
  const hookInbox = new HookInbox(app.getPath('userData'), (text) => approvals.learn(text));
  await mkdir(inboxDir(app.getPath('userData')), { recursive: true }).catch(() => undefined);
  progressService = new ProgressService(
    new MultiProgressSource(() => {
      const list: ProgressSource[] = [workbuddySource];
      if (agentSources.claudeCode) list.push(claudeSource);
      if (agentSources.codex) list.push(codexSource);
      return list;
    }),
    Date.now,
    hookInbox,
  );
  // 逐次确认：跑命令、看屏幕/摄像头、派活之前先问你。桌宠 A/B、面板按钮、实体按键都能答。
  confirmService = new ConfirmService();
  confirmService.subscribe((snapshot) => {
    broadcast('companion:confirm-state', snapshot);
    pushDeviceView();
  });
  // 远程批准：Claude Code / WorkBuddy 的权限请求进同一张确认卡；没人理就交回终端。
  const counter = new UsageService(join(app.getPath('userData'), 'usage-v1.json'));
  await counter.load();
  usage = counter;
  // 家庭设备普查：只在面板点按钮时扫，只读；结果只发给面板。
  const scanner = new LanScanService(join(app.getPath('userData'), 'lan-scan-v1.json'));
  await scanner.load();
  scanner.subscribe((state) => {
    if (panel && !panel.isDestroyed()) panel.webContents.send('companion:lan-scan-state', state);
  });
  lanScan = scanner;
  agentPermissions = new AgentPermissionBridge(hooksDir(app.getPath('userData')), confirmService, {
    remember: (request) => approvals.remember(request.source, request.cwd, request.keys),
    log: (event, fields) => {
      log.info(event, fields);
      if (event === 'agent-permission') counter.permission(fields['outcome'], fields['ms']);
    },
  });
  await agentPermissions.load();
  agentPermissions.start();
  // 主动开口 + 关系账本：本地事件触发、本地台词，不出站。
  proactiveService = new ProactiveService(
    {
      config: join(app.getPath('userData'), 'proactive-v1.json'),
      bond: join(app.getPath('userData'), 'bond-v1.json'),
    },
    () => personaService.snapshot(),
  );
  await proactiveService.init();
  // 钩子自检：装过的钩子被别的工具（如 cc-switch 还原配置）拆掉时，第一次问你，同意后自动装回。
  hookWatch = new HookWatchService(
    hookInstaller,
    join(app.getPath('userData'), 'hook-watch-v1.json'),
    () => readFile(inboxPath(app.getPath('userData')), 'utf8'),
    {
      ask: (targets, key) => {
        log.warn('hooks-lost', { targets: targets.join(',') });
        proactiveService.offer({ kind: 'hooks-lost', key, subject: lostText(targets) });
      },
      repaired: (record) => {
        if (record.ok) log.info('hooks-repaired', { targets: record.targets.join(',') });
        else
          log.warn('hooks-repair-failed', {
            targets: record.targets.join(','),
            error: record.error,
          });
        proactiveService.offer({
          kind: record.ok ? 'hooks-fixed' : 'hooks-lost',
          key: `hooks-repair:${record.at}`,
          subject: lostText(record.targets),
        });
      },
    },
  );
  await hookWatch.load();
  hookWatch.subscribe((snapshot) => {
    if (panel && !panel.isDestroyed()) panel.webContents.send('companion:hooks-watch', snapshot);
  });
  hookWatch.start();
  let shownNudge = '';
  proactiveService.subscribe((snapshot) => {
    broadcast('companion:proactive-state', snapshot);
    pushDeviceView();
    // 新上屏的提醒：桌宠藏起来时用系统通知补一下；勿扰时不弹。
    const current = snapshot.current;
    if (current && current.id !== shownNudge) {
      shownNudge = current.id;
      const quiet = service.snapshot().state.settings.quiet;
      const hidden = !companion || companion.isDestroyed() || !companion.isVisible();
      if (!quiet && hidden && Notification.isSupported()) {
        new Notification({ title: '芯伴', body: current.text, silent: true }).show();
      }
    }
  });
  // 实体设备：USB 串口优先，另有模拟设备用于没硬件时跑通协议。默认关。
  deviceService = new DeviceService(
    join(app.getPath('userData'), 'device-v1.json'),
    { serial: new SerialConnector(), simulated: simulatedDevice },
    Date.now,
    undefined,
    join(app.getPath('userData'), 'iot-v1.json'),
  );
  deviceService.subscribe((snapshot) => broadcast('companion:device-state', snapshot));
  deviceService.onGesture((button, gesture) => {
    touchPresence();
    applyIntent(intentFor(gestureContext(), button, gesture));
  });
  await deviceService.init();
  let priorWork: WorkProgressState = progressService.snapshot();
  progressService.subscribe((state) => {
    broadcast('companion:work-state', withSources(state));
    proactiveService.offerAll(detectWorkNudges(priorWork, state));
    priorWork = state;
    workbench?.refresh();
    pushDeviceView();
  });
  progressService.start();
  // 工具的工作目录：默认是 userData 下独立的 workspace（沙盒目录），不是应用自身。
  // 以前默认应用目录，模型能改到自己的主进程代码——等于能删掉自己的安全层。
  // 要让它作用在你的项目上，用 XINBAN_WORKSPACE 显式指过去。
  const workspaceRoot = process.env.XINBAN_WORKSPACE ?? join(app.getPath('userData'), 'workspace');
  await mkdir(workspaceRoot, { recursive: true }).catch(() => undefined);
  // 主动放声音：主进程服务 + 隐藏窗口播放器。本地音频只允许来自工作目录，
  // 或用户用 XINBAN_AUDIO_DIRS（按系统路径分隔符分列）显式指定的额外目录。
  const audioRoots = [
    workspaceRoot,
    ...(process.env['XINBAN_AUDIO_DIRS'] ?? '')
      .split(delimiter)
      .map((dir) => dir.trim())
      .filter((dir) => dir !== '')
      .map((dir) => resolve(dir)),
  ];
  // 音乐客户端控制：只在 Windows 上有系统媒体桥；桥是懒启动的，没用过音乐就不会起。
  musicService = new MusicService(
    process.platform === 'win32' && process.env['XINBAN_NO_MEDIA'] !== '1'
      ? new PowerShellMediaBridge()
      : null,
  );
  musicService.subscribe((snapshot) => {
    broadcast('companion:music-state', snapshot);
    pushDeviceView();
  });
  audioPlayer = new ElectronAudioPlayer();
  audioService = new AudioService(audioPlayer, audioRoots);
  // 派活：把整件事交给本机的 AI Agent 命令行，或（授权后）跑系统命令。
  // 两个开关默认关；init 里把每个目标探测一遍（含 WorkBuddy 自带的 CLI），
  // 面板一打开就知道能派给谁。
  delegateService = new DelegateService(
    new DelegateStore(join(app.getPath('userData'), 'delegate-v1.json')),
    workspaceRoot,
    undefined,
    join(app.getPath('userData'), 'delegate-history-v1.json'),
    (cwd) => gitBaseline(cwd),
  );
  await delegateService.init();
  delegateService.subscribe((snapshot) => {
    for (const window of windows.keys()) {
      if (!window.isDestroyed()) window.webContents.send('companion:delegate-state', snapshot);
    }
    counter.delegates(snapshot.history);
    workbench?.refresh();
  });
  // 工作台：合并钩子会话与派活记录；「已看」存 workbench-v1.json。
  const bench = new WorkbenchService(
    join(app.getPath('userData'), 'workbench-v1.json'),
    () => progressService.snapshot(),
    () => delegateService.snapshot(),
  );
  await bench.load();
  workbench = bench;
  // 推到手机：只在系统空闲够久时推标题；地址用系统加密存。
  const push = new PhonePushService(
    join(app.getPath('userData'), 'phone-push-v1.json'),
    aiCrypto,
    () => powerMonitor.getSystemIdleTime(),
    (url, init) => fetch(url, init),
  );
  await push.load();
  phonePush = push;
  const pushTick = (snapshot: ReturnType<typeof bench.refresh>): void => {
    void push
      .tick(snapshot)
      .then((count) => {
        if (count > 0) log.info('phone-push', { count });
      })
      .catch(() => undefined);
  };
  bench.subscribe((state) => {
    broadcast('companion:workbench-state', state);
    pushDeviceView();
    pushTick(state);
  });
  counter.baseline(delegateService.snapshot().history);
  const workbenchTick = (): void => {
    const snapshot = bench.refresh();
    counter.observe(snapshot);
    pushTick(snapshot);
    // 等了 2 分钟还没理：桌宠提醒一次（走打扰预算，勿扰时不出声）。
    proactiveService.offerAll(longWaitNudges(snapshot, bench.seenMap(), Date.now()));
  };
  workbenchTimer = setInterval(workbenchTick, 30_000);
  workbenchTimer.unref?.();
  // MCP：服务器只在面板里加/导入；密钥用系统加密另存。启动在后台，不拖慢窗口。
  const mcp = new McpService(
    {
      config: join(app.getPath('userData'), 'mcp-servers-v1.json'),
      secrets: join(app.getPath('userData'), 'mcp-secrets-v1.json'),
    },
    aiCrypto,
    workspaceRoot,
    defaultChannelFactory,
    (event, fields) => log.info(event, fields),
  );
  await mcp.load();
  mcpService = mcp;
  mcp.subscribe((snapshot) => {
    if (panel && !panel.isDestroyed()) panel.webContents.send('companion:mcp-state', snapshot);
  });
  mcp.startAll();
  const attachments = new AttachmentService(workspaceRoot);
  void attachments.prune();
  // 授权目录：只有面板能加；写入前备份到 userData/file-backups，面板里可撤销。
  const files = new FileAccessService(
    {
      config: join(app.getPath('userData'), 'file-roots-v1.json'),
      changes: join(app.getPath('userData'), 'file-changes-v1.json'),
      backups: join(app.getPath('userData'), 'file-backups'),
    },
    { home: app.getPath('home'), userData: app.getPath('userData'), appDir: app.getAppPath() },
  );
  await files.load();
  fileAccess = files;
  files.subscribe((snapshot) => {
    // 改动记录里有文件路径：只发面板，不发桌宠。
    if (panel && !panel.isDestroyed()) panel.webContents.send('companion:files-state', snapshot);
  });
  aiService.setTools(
    new ToolExecutor(
      {
        postJson: (path, body, signal) => aiService.postJson(path, body, signal),
        snapshot: () => service.snapshot(),
        dispatch: (action) => service.dispatch(action),
        memory: {
          remember: (text, category, source) =>
            memoryService.remember(text, category, source ?? 'said'),
          forget: (query) => memoryService.forget(query),
          search: (query, limit) => memoryService.search(query, limit),
        },
        progress: { text: () => progressService.toolText() },
        senses: { text: () => sensesText(sensesService.snapshot(), Date.now()) },
        vision: { look: (input, signal) => visionService.look(input, signal) },
        delegate: {
          enabled: () => delegateService.snapshot().config.allowAgents,
          shellAllowed: () => delegateService.shellAllowed(),
          targets: () => delegateService.snapshot().targets,
          /**
           * 派活在后台干：进程起来后不再卡住对话。
           * 启动后 1.5 秒内就结束的（找不到命令、没登录）仍当场交回，模型能直接说原因；
           * 其余情况先回「已派出」，干完把结果贴进对话。
           */
          run: async (input, signal) => {
            const started = Date.now();
            const job = new AbortController();
            // 还没交回「已派出」之前取消对话，连带止住这件活；之后两者互不相干。
            const onChatAbort = (): void => job.abort();
            signal.addEventListener('abort', onChatAbort, { once: true });
            let label = '外部 Agent';
            let markStarted: () => void = () => undefined;
            const launched = new Promise<void>((resolve) => {
              markStarted = resolve;
            });
            const done = delegateService.run(input, job.signal, {
              onStarted: (info) => {
                label = info.target;
                aiSession.startJob({ target: info.target, task: info.task, startedAt: Date.now() });
                markStarted();
              },
              onOutput: (chunk) => aiSession.jobOutput(chunk),
            });
            const finish = (result: DelegateRunResult): void => {
              log[result.ok ? 'info' : 'warn']('delegate', {
                target: input.target,
                project: input.project,
                ok: result.ok,
                ms: Date.now() - started,
                error: result.ok ? undefined : result.error,
              });
              if (result.ok) proactiveService.delegated();
            };
            const early = await Promise.race([
              done.then((result) => ({ result })),
              launched.then(
                () =>
                  new Promise<null>((resolve) => {
                    setTimeout(() => resolve(null), 1_500);
                  }),
              ),
            ]);
            signal.removeEventListener('abort', onChatAbort);
            if (early !== null) {
              aiSession.startJob(null);
              finish(early.result);
              return early.result;
            }
            delegateJob = job;
            void done.then((result) => {
              if (delegateJob === job) delegateJob = null;
              aiSession.startJob(null);
              finish(result);
              const ms = Date.now() - started;
              aiSession.deliver(delegateReport(result, label, ms), `交给 ${label} 干的结果`);
              // 活跑了超过一分钟，你大概已经走开了：干完时主动说一声。
              if (ms > 60_000 && !job.signal.aborted) {
                proactiveService.offer({
                  kind: result.ok ? 'delegate-done' : 'delegate-failed',
                  key: `delegate:${started}`,
                  subject: input.task,
                  source: result.ok ? result.target : '外部 Agent',
                });
              }
            });
            return {
              ok: true,
              text: '',
              note: `${label} 在后台干`,
              target: label,
              background: true,
            };
          },
        },
        audio: { play: (input) => audioService.play(input) },
        music: {
          run: async (command) => {
            const result =
              command === 'state'
                ? await musicService.refresh()
                : await musicService.control(command);
            return result.ok
              ? { ok: true, nowPlaying: result.snapshot.nowPlaying }
              : { ok: false, error: result.error };
          },
        },
        confirm: (request, signal) => confirmService.request(request, signal),
        feishu: {
          configured: () => phonePush?.view().configured === true,
          send: async (text) => {
            const result = phonePush
              ? await phonePush.sendMessage(text)
              : { ok: false as const, error: '还没准备好。' };
            // 只记成没成，不记内容。
            log.info('feishu-chat', { ok: result.ok });
            return result;
          },
        },
        mcp: {
          describe: (name) => mcp.describe(name),
          call: (name, args, signal) => mcp.call(name, args, signal),
        },
        files: {
          roots: () => files.roots(),
          revision: () => files.revision(),
          commit: async (input, signal) => {
            const change = await files.commit(input, signal);
            // 只记动作和目录名，不记文件名和内容。
            log.info('file-write', { root: input.root, tool: input.tool, action: change.action });
            return change;
          },
        },
      },
      workspaceRoot,
    ),
  );
  aiSession = new AiSessionService(aiService, memoryService, {
    // 工作进度与关系背景都是「环境」，拼在同一个注入位。
    prompt: () =>
      [progressService.prompt(), proactiveService.prompt()]
        .filter((block) => block !== '')
        .join('\n\n'),
    persona: () => personaService.snapshot(),
    senses: () => {
      // 感官读数和「他可能是说出来的」是同一类信息：都是环境，不是用户说的话，
      // 所以拼成一块塞进同一个注入位，不额外占一个提示词段落。
      const speech = sttService.snapshot();
      return [
        sensesPrompt(sensesService.snapshot(), Date.now()),
        sttPrompt(speech.config, speech.status === 'ready'),
        // 视觉单独一段：它说的不是「环境读数」，而是「你有个眼睛，怎么用」。
        // 少了这段，模型会按常识回答「我是文本模型，看不到画面」——用户听到的就是这句。
        visionPrompt(visionService.snapshot().config),
      ]
        .filter((block) => block !== '')
        .join('\n\n');
    },
    delegate: () => {
      const snapshot = delegateService.snapshot();
      // 授权目录和派活同属「你能动哪些东西」，拼在同一个注入位。
      return [
        delegatePrompt(snapshot.config, snapshot.targets, snapshot.projects),
        fileRootsPrompt(files.roots()),
        mcpPrompt(mcp.snapshot().servers),
      ]
        .filter((block) => block !== '')
        .join('\n\n');
    },
    tools: () => mcp.specs(),
  });
  // 对话状态广播给所有窗口：桌宠小屏和控制面板看到同一段对话，任意一处提问都会同步。
  let wasBusy = false;
  aiSession.subscribe((state) => {
    broadcast('companion:ai-session', state);
    if (wasBusy && !state.busy) replyShownAt = Date.now();
    wasBusy = state.busy;
    pushDeviceView();
  });
  // 确认：两个窗口都能看、都能答（桌宠上按 A/B，面板里点按钮）。
  // 音乐：两个窗口都能看、都能按（桌宠屏脚点一下暂停）。
  ipcMain.handle('companion:music-state', (event) => {
    verify(event);
    return musicService.snapshot();
  });
  ipcMain.handle('companion:music-refresh', async (event) => {
    verify(event);
    return musicService.refresh();
  });
  ipcMain.handle('companion:music-control', async (event, raw: unknown) => {
    verify(event);
    if (raw !== 'toggle' && raw !== 'next' && raw !== 'prev') {
      return { ok: false, error: '参数无效。' };
    }
    return musicService.control(raw);
  });
  ipcMain.handle('companion:confirm-state', (event) => {
    verify(event);
    return confirmService.snapshot();
  });
  ipcMain.handle('companion:confirm-answer', (event, id: unknown, allow: unknown) => {
    verify(event);
    touchPresence();
    if (typeof id !== 'string' || id.length > 64 || typeof allow !== 'boolean') {
      return { ok: false, error: '参数无效。' };
    }
    return confirmService.answer(id, allow)
      ? { ok: true }
      : { ok: false, error: '这条请求已经过期了。' };
  });
  // 工作台：两边都能看、标「已看」、看改动摘要、开编辑器（桌宠小屏上就能处理待看）；
  // 完整 diff 和改编辑器命令只有面板。
  // 渲染进程只传工作台里已有的 key，路径由主进程自己查。
  const workbenchKey = (raw: unknown): string | null =>
    typeof raw === 'string' && raw.length > 0 && raw.length <= 200 ? raw : null;
  ipcMain.handle('companion:workbench-state', (event) => {
    verify(event);
    return workbench?.state() ?? null;
  });
  ipcMain.handle('companion:workbench-seen', async (event, raw: unknown) => {
    verify(event);
    touchPresence();
    const key = workbenchKey(raw);
    if (key === null || !workbench) return { ok: false, error: '参数无效。' };
    return (await workbench.markSeen(key))
      ? { ok: true }
      : { ok: false, error: '这一项已经不在工作台上了。' };
  });
  ipcMain.handle('companion:workbench-review', async (event, raw: unknown) => {
    verify(event);
    const key = workbenchKey(raw);
    if (key === null || !workbench) return null;
    return workbench.review(key);
  });
  ipcMain.handle('companion:workbench-diff', async (event, raw: unknown) => {
    verifyPanel(event);
    const key = workbenchKey(raw);
    if (key === null || !workbench) return { ok: false, error: '参数无效。' };
    return workbench.diff(key);
  });
  ipcMain.handle('companion:workbench-open', async (event, raw: unknown) => {
    verify(event);
    touchPresence();
    const key = workbenchKey(raw);
    if (key === null || !workbench) return { ok: false, error: '参数无效。' };
    const result = await workbench.openEditor(key);
    log.info('workbench-open', { ok: result.ok });
    return result;
  });
  // 推到手机：只有面板能看、能改、能发测试；地址只进不出。
  ipcMain.handle('companion:usage-state', (event) => {
    verifyPanel(event);
    return usage?.view() ?? null;
  });
  ipcMain.handle('companion:lan-scan-state', (event) => {
    verifyPanel(event);
    if (!lanScan) return null;
    if (!lanScan.snapshot().running) lanScan.refreshSubnets();
    return lanScan.snapshot();
  });
  ipcMain.handle('companion:lan-scan-start', (event, raw: unknown) => {
    verifyPanel(event);
    if (!lanScan) return { ok: false, error: '还没准备好。' };
    if (typeof raw !== 'string' || raw.length > 32) return { ok: false, error: '参数无效。' };
    const result = lanScan.start(raw);
    log.info('lan-scan-start', { ok: result.ok });
    return result;
  });
  ipcMain.handle('companion:phone-push-state', (event) => {
    verifyPanel(event);
    return phonePush?.view() ?? null;
  });
  ipcMain.handle('companion:phone-push-save', async (event, raw: unknown) => {
    verifyPanel(event);
    if (!phonePush || typeof raw !== 'object' || raw === null) {
      return { ok: false, error: '参数无效。' };
    }
    const input = raw as Record<string, unknown>;
    const text = (value: unknown): string | undefined =>
      typeof value === 'string' && value.length <= 500 ? value : undefined;
    return phonePush.save({
      enabled: input['enabled'] === true,
      idleMinutes: typeof input['idleMinutes'] === 'number' ? input['idleMinutes'] : 0,
      webhook: text(input['webhook']),
      secret: text(input['secret']),
    });
  });
  ipcMain.handle('companion:phone-push-test', async (event) => {
    verifyPanel(event);
    if (!phonePush) return { ok: false, error: '还没准备好。' };
    const result = await phonePush.test();
    log.info('phone-push-test', { ok: result.ok });
    return result;
  });
  ipcMain.handle('companion:workbench-editor', async (event, raw: unknown) => {
    verifyPanel(event);
    if (typeof raw !== 'string' || !workbench) return { ok: false, error: '参数无效。' };
    return workbench.setEditor(raw);
  });
  // 外部 Agent 卡片上的「交回终端」「以后同类都批」。
  ipcMain.handle('companion:confirm-external', (event, id: unknown, action: unknown) => {
    verify(event);
    touchPresence();
    if (typeof id !== 'string' || id.length > 64 || (action !== 'defer' && action !== 'remember')) {
      return { ok: false, error: '参数无效。' };
    }
    return confirmService.answerExternal(id, action)
      ? { ok: true }
      : { ok: false, error: '这条请求已经过期了。' };
  });
  // 主动开口：读放行两边，回应也放行两边；设置只在面板改。
  ipcMain.handle('companion:proactive-state', (event) => {
    verify(event);
    return proactiveService.snapshot();
  });
  ipcMain.handle('companion:proactive-answer', (event, id: unknown, answer: unknown) => {
    verify(event);
    touchPresence();
    return answerNudge(id, answer);
  });
  ipcMain.handle('companion:proactive-save', async (event, input: unknown) => {
    verifyPanel(event);
    return proactiveService.saveConfig(input);
  });
  // 实体设备：状态两边都能读，启用/换端口只在面板。
  ipcMain.handle('companion:device-state', (event) => {
    verify(event);
    return deviceService.snapshot();
  });
  // 物联网：登记与开关都只收面板的——这是在控制真实的电源，入口越少越好。
  ipcMain.handle('companion:iot-save', async (event, input: unknown) => {
    verifyPanel(event);
    return deviceService.saveIot(input);
  });
  ipcMain.handle('companion:iot-set', (event, id: unknown, on: unknown) => {
    verifyPanel(event);
    return deviceService.iotSet(id, on);
  });
  ipcMain.handle('companion:device-save', async (event, input: unknown) => {
    verifyPanel(event);
    return deviceService.save(input);
  });
  ipcMain.handle('companion:device-refresh', async (event) => {
    verifyPanel(event);
    return deviceService.refreshPorts();
  });
  // 模拟设备的按键：只在模拟模式下生效，走与真硬件完全相同的协议链路。
  ipcMain.handle('companion:device-sim-press', (event, button: unknown, edge: unknown) => {
    verifyPanel(event);
    if (deviceService.snapshot().config.mode !== 'simulated') return { ok: false };
    if ((button !== 'A' && button !== 'B') || (edge !== 'down' && edge !== 'up')) {
      return { ok: false };
    }
    simulatedDevice.press(button, edge, performance.now());
    return { ok: true };
  });
  ipcMain.handle('companion:ai-status', (event) => {
    // 桌宠需要知道是否已配置，才能在屏幕上给出「去配置」而不是假装回答。
    verify(event);
    return aiService.status();
  });
  ipcMain.handle('companion:ai-configure', (event, input: unknown) => {
    verifyPanel(event);
    return aiService.configure(input);
  });
  ipcMain.handle('companion:ai-clear', (event) => {
    verifyPanel(event);
    return aiService.clear();
  });
  ipcMain.handle('companion:ai-session', (event) => {
    verify(event);
    return aiSession.snapshot();
  });
  // 附件：两个窗口都能拖。文件先复制进沙盒 uploads/，模型只碰副本。
  ipcMain.handle('companion:attach-pick', async (event) => {
    verify(event);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: '选文件发给芯伴',
      properties: ['openFile', 'multiSelections'],
    };
    const picked = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled) return { ok: false, error: '' };
    return attachments.stage(picked.filePaths);
  });
  ipcMain.handle('companion:attach-paths', (event, raw: unknown) => {
    verify(event);
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string' || item.length > 1024)) {
      return { ok: false, error: '参数无效。' };
    }
    return attachments.stage(raw as string[]);
  });
  ipcMain.handle('companion:ai-send', async (event, text: unknown, ids: unknown) => {
    // 桌宠与控制面板都可发起对话；这里仍校验来源窗口与顶层 frame。
    verify(event);
    touchPresence();
    if (typeof text !== 'string') return { ok: false, error: '消息格式无效。' };
    const attached = Array.isArray(ids)
      ? attachments.take(ids.filter((id): id is string => typeof id === 'string'))
      : [];
    const attach =
      attached.length === 0
        ? undefined
        : {
            line: attachmentLine(attached),
            prompt: attachmentPrompt(attached, await attachments.texts(attached), wrapUntrusted),
          };
    const started = Date.now();
    return aiSession.send(text, attach).then((result) => {
      // 只记成败与耗时；失败原因是我们自己生成的提示语，不含你问了什么。
      // 记忆注入只记条数：注入了几条、其中几条和问题相关，用来看精度。
      const memory = memoryService.injectionStats().last;
      const fields = {
        ms: Date.now() - started,
        memInjected: memory?.injected,
        memMatched: memory?.matched,
        attachments: attached.length || undefined,
      };
      if (result.ok) appLog?.info('ai-turn', { ok: true, ...fields });
      else appLog?.warn('ai-turn', { ok: false, ...fields, error: result.error });
      return result;
    });
  });
  ipcMain.handle('companion:health', (event) => {
    verifyPanel(event);
    return appLog?.snapshot() ?? null;
  });
  // MCP：只收面板——这决定了本机会起什么进程、连什么地址。
  const mcpInput = z
    .object({
      previous: z.string().max(64).optional(),
      name: z.string().max(64),
      transport: z.enum(['stdio', 'http']),
      command: z.string().max(500),
      args: z.array(z.string().max(mcpLimits.argChars)).max(mcpLimits.maxArgs),
      cwd: z.string().max(500),
      url: z.string().max(mcpLimits.urlChars),
      secrets: z
        .object({
          env: z.record(z.string().max(128), z.string().max(mcpLimits.secretChars)),
          headers: z.record(z.string().max(128), z.string().max(mcpLimits.secretChars)),
        })
        .nullable(),
    })
    .strict();
  const mcpName = (raw: unknown): string | null =>
    typeof raw === 'string' && raw.length <= 64 ? raw : null;
  const bad = { ok: false, error: '参数无效。' } as const;
  ipcMain.handle('companion:mcp-state', (event) => {
    verifyPanel(event);
    return mcp.snapshot();
  });
  ipcMain.handle('companion:mcp-save', (event, raw: unknown) => {
    verifyPanel(event);
    const parsed = mcpInput.safeParse(raw);
    return parsed.success ? mcp.save(parsed.data) : bad;
  });
  ipcMain.handle('companion:mcp-remove', (event, raw: unknown) => {
    verifyPanel(event);
    const name = mcpName(raw);
    return name === null ? bad : mcp.remove(name);
  });
  ipcMain.handle('companion:mcp-enable', (event, raw: unknown, enabled: unknown) => {
    verifyPanel(event);
    const name = mcpName(raw);
    return name === null || typeof enabled !== 'boolean' ? bad : mcp.setEnabled(name, enabled);
  });
  ipcMain.handle('companion:mcp-trust', (event, raw: unknown, trust: unknown) => {
    verifyPanel(event);
    const name = mcpName(raw);
    return name === null || (trust !== 'ask' && trust !== 'auto') ? bad : mcp.setTrust(name, trust);
  });
  ipcMain.handle(
    'companion:mcp-tool-trust',
    (event, raw: unknown, tool: unknown, trust: unknown) => {
      verifyPanel(event);
      const name = mcpName(raw);
      if (name === null || typeof tool !== 'string' || tool.length > 128) return bad;
      if (trust !== 'ask' && trust !== 'auto' && trust !== null) return bad;
      return mcp.setToolTrust(name, tool, trust);
    },
  );
  ipcMain.handle('companion:mcp-restart', async (event, raw: unknown) => {
    verifyPanel(event);
    const name = mcpName(raw);
    if (name === null || !mcp.snapshot().servers.some((server) => server.name === name)) return bad;
    void mcp.start(name);
    return { ok: true };
  });
  ipcMain.handle('companion:mcp-import', (event, source: unknown) => {
    verifyPanel(event);
    if (source === 'claude-code') return mcp.importFrom(join(app.getPath('home'), '.claude.json'));
    if (source === 'claude-desktop') {
      return mcp.importFrom(join(app.getPath('appData'), 'Claude', 'claude_desktop_config.json'));
    }
    return bad;
  });
  // 授权目录：只收面板——这决定了模型能碰你哪些文件。
  ipcMain.handle('companion:files-state', (event) => {
    verifyPanel(event);
    return files.snapshot();
  });
  ipcMain.handle('companion:files-add', async (event, raw: unknown, writable: unknown) => {
    verifyPanel(event);
    if ((raw !== null && typeof raw !== 'string') || typeof writable !== 'boolean') {
      return { ok: false, error: '参数无效。' };
    }
    let path = raw;
    if (path === null) {
      const picked = await dialog.showOpenDialog(panel, {
        title: '选一个给芯伴用的目录',
        properties: ['openDirectory'],
      });
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: '' };
      path = picked.filePaths[0];
    }
    const result = await files.add(path, writable);
    if (result.ok) log.info('file-root-add', { writable });
    return result;
  });
  ipcMain.handle('companion:files-remove', (event, name: unknown) => {
    verifyPanel(event);
    if (typeof name !== 'string') return { ok: false, error: '参数无效。' };
    return files.remove(name);
  });
  ipcMain.handle('companion:files-writable', (event, name: unknown, writable: unknown) => {
    verifyPanel(event);
    if (typeof name !== 'string' || typeof writable !== 'boolean') {
      return { ok: false, error: '参数无效。' };
    }
    return files.setWritable(name, writable);
  });
  ipcMain.handle('companion:files-undo', async (event, id: unknown) => {
    verifyPanel(event);
    if (typeof id !== 'string' || id.length > 40) return { ok: false, error: '参数无效。' };
    const result = await files.undo(id);
    log[result.ok ? 'info' : 'warn']('file-undo', { ok: result.ok });
    return result;
  });
  ipcMain.handle('companion:health-open-logs', async (event) => {
    verifyPanel(event);
    if (!appLog) return { ok: false, error: '日志还没启动。' };
    const failure = await shell.openPath(appLog.snapshot().logDir);
    return failure === '' ? { ok: true } : { ok: false, error: failure };
  });
  ipcMain.handle('companion:ai-cancel', (event) => {
    verify(event);
    aiSession.cancel();
  });
  // 停下后台派活：两个窗口都能点，和「取消回复」是两回事。
  ipcMain.handle('companion:delegate-cancel', (event) => {
    verify(event);
    delegateJob?.abort();
  });
  // 记忆只在面板里管理：桌宠小屏没有空间展示与编辑，也不该让误触删掉记忆。
  ipcMain.handle('companion:memory-state', (event) => {
    verifyPanel(event);
    return memoryService.snapshot();
  });
  ipcMain.handle('companion:memory-remove', async (event, id: unknown) => {
    verifyPanel(event);
    if (typeof id !== 'string' || id.length > 64) return { ok: false, error: '记忆 id 无效。' };
    const removed = await memoryService.remove(id);
    return removed ? { ok: true } : { ok: false, error: '没有找到这条记忆。' };
  });
  ipcMain.handle('companion:memory-clear', async (event) => {
    verifyPanel(event);
    await memoryService.clear();
    await memoryTidy.refresh();
    return { ok: true };
  });
  ipcMain.handle('companion:memory-tidy-state', (event) => {
    verifyPanel(event);
    return memoryTidy.snapshot();
  });
  ipcMain.handle('companion:memory-tidy-start', (event) => {
    verifyPanel(event);
    return memoryTidy.start();
  });
  ipcMain.handle('companion:memory-tidy-apply', (event, ids: unknown) => {
    verifyPanel(event);
    if (
      !Array.isArray(ids) ||
      ids.length > 200 ||
      !ids.every((id) => typeof id === 'string' && id.length <= 16)
    ) {
      return memoryTidy.snapshot();
    }
    return memoryTidy.apply(ids as string[]);
  });
  ipcMain.handle('companion:memory-tidy-discard', (event) => {
    verifyPanel(event);
    return memoryTidy.discard();
  });
  ipcMain.handle('companion:memory-tidy-undo', (event) => {
    verifyPanel(event);
    return memoryTidy.undo();
  });
  // 性格只读放开给桌宠：屏幕闲时那句标语存在这份配置里。
  // 写仍然只走面板——小屏上错点一下就换个说话风格，太容易了。
  ipcMain.handle('companion:persona-state', (event) => {
    verify(event);
    return personaService.snapshot();
  });
  ipcMain.handle('companion:persona-save', async (event, input: unknown) => {
    verifyPanel(event);
    const result = await personaService.save(input);
    return result.ok ? { ok: true } : { ok: false, error: result.error ?? '保存失败。' };
  });
  // 桌宠要读开关（决定采不采）与读数（决定表情），面板要读来显示状态，两边都放行读。
  ipcMain.handle('companion:senses-state', (event) => {
    verify(event);
    return sensesService.snapshot();
  });
  ipcMain.handle('companion:senses-save', async (event, input: unknown) => {
    verifyPanel(event);
    const result = await sensesService.save(input);
    if (result.ok) await askMediaAccess(result.snapshot.config);
    return result.ok ? { ok: true } : { ok: false, error: result.error ?? '保存失败。' };
  });
  // 读数只收桌宠窗口的：别的窗口没有采集权，也就不该能伪造「他在说话」。
  ipcMain.on('companion:senses-report', (event, reading: unknown) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    if (
      !sender ||
      sender !== companion ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame.url !== windows.get(sender)
    )
      return;
    sensesService.report(reading, Date.now());
  });
  // 桌宠要读（决定用哪副嗓子），面板要读写（换嗓子）。读放行两边，写只给面板。
  ipcMain.handle('companion:voice-state', (event) => {
    verify(event);
    return voiceService.snapshot();
  });
  ipcMain.handle('companion:voice-save', async (event, input: unknown) => {
    verifyPanel(event);
    const result = await voiceService.save(input);
    return result.ok ? { ok: true } : { ok: false, error: result.error ?? '保存失败。' };
  });
  // 合成要两边都能用：桌宠念回复，面板试听。音频仅在内存中传递，照样只认自己的窗口。
  ipcMain.handle('companion:tts-stop', (event) => {
    // 云端合成每句一个短请求，打断由渲染进程丢弃晚到的结果即可，这里无事可做。
    verify(event);
  });
  ipcMain.handle('companion:stt-stop', (event) => {
    verify(event);
    sttService.stop();
  });
  ipcMain.handle('companion:tts-state', (event) => {
    verify(event);
    return ttsService.snapshot();
  });
  ipcMain.handle('companion:tts-speak', async (event, input: unknown) => {
    verify(event);
    return ttsService.synthesize(input);
  });
  // 视觉：读放行两边（桌宠要知道能不能看），改与「当场看一眼」只给面板。
  // 手动看一眼是给人验证用的，不该成为小屏上一个能随手触发的截屏按钮。
  ipcMain.handle('companion:vision-state', (event) => {
    verify(event);
    return visionService.snapshot();
  });
  ipcMain.handle('companion:vision-save', async (event, input: unknown) => {
    verifyPanel(event);
    const result = await visionService.save(input);
    return result.ok ? { ok: true } : { ok: false, error: result.error ?? '保存失败。' };
  });
  ipcMain.handle('companion:vision-look', async (event, input: unknown) => {
    verifyPanel(event);
    return visionService.look(input);
  });
  // 派活：只在面板里改。桌宠小屏不给入口——授权把动手权交出去这件事，
  // 不该是误触一下就发生的事。
  ipcMain.handle('companion:delegate-state', (event) => {
    verify(event);
    return delegateService.snapshot();
  });
  ipcMain.handle('companion:delegate-save', async (event, input: unknown) => {
    verifyPanel(event);
    const result = await delegateService.save(input);
    return result.ok ? { ok: true } : { ok: false, error: result.error ?? '保存失败。' };
  });
  ipcMain.handle('companion:delegate-probe', async (event) => {
    verifyPanel(event);
    return delegateService.probe();
  });
  ipcMain.handle('companion:stt-state', (event) => {
    verify(event);
    return sttService.snapshot();
  });
  ipcMain.handle('companion:stt-save', async (event, input: unknown) => {
    verifyPanel(event);
    const result = await sttService.saveConfig(input);
    return result.ok ? { ok: true } : { ok: false, error: result.error ?? '保存失败。' };
  });
  ipcMain.handle('companion:stt-save-key', async (event, input: unknown) => {
    verifyPanel(event);
    const result = await sttService.saveKey(input);
    return result.ok ? { ok: true } : { ok: false, error: result.error ?? '保存失败。' };
  });
  ipcMain.handle('companion:stt-clear-key', async (event) => {
    verifyPanel(event);
    await sttService.clearKey();
    return { ok: true };
  });
  // 音频只收桌宠窗口的：那里才有麦克风权限，面板根本没有录音能力。
  ipcMain.handle('companion:stt-transcribe', async (event, audio: unknown, mime: unknown) => {
    verifyPet(event);
    return sttService.transcribe(audio, mime);
  });
  ipcMain.handle('companion:work-state', async (event) => {
    verify(event);
    return withSources(progressService.snapshot());
  });
  ipcMain.handle('companion:work-refresh', async (event) => {
    verify(event);
    return withSources(await progressService.scan());
  });
  // 盯哪些 agent：只有面板能改。
  ipcMain.handle('companion:work-sources-save', async (event, raw: unknown) => {
    verifyPanel(event);
    const next = normalizeAgentSources(raw);
    try {
      await writeJsonAtomic(agentSourcesPath, { version: 1, ...next });
    } catch {
      return { ok: false, error: '没保存上，请重试。' };
    }
    agentSources = next;
    const state = await progressService.reload();
    // 内容没变时 ProgressService 不会广播，开关状态得自己推一次。
    broadcast('companion:work-state', withSources(state));
    return { ok: true };
  });
  // 官方通知钩子：要改用户自己的 Claude Code / Codex 配置，只有面板能触发，且每次都是用户点的。
  ipcMain.handle('companion:hooks-status', async (event) => {
    verifyPanel(event);
    return hookInstaller.status();
  });
  ipcMain.handle('companion:hooks-apply', async (event, raw: unknown) => {
    verifyPanel(event);
    const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const target = input['target'];
    const action = input['action'];
    if (!isHookTarget(target) || (action !== 'install' && action !== 'uninstall')) {
      return { ok: false, error: '参数无效。' };
    }
    const result = await hookInstaller.apply(target, action);
    // 你亲手装/卸的记下来：自检只护住你装过的，卸掉的不会被装回去。
    if (result.ok) await hookWatch?.applied(target, action);
    return result.ok ? { ok: true, status: await hookInstaller.status() } : result;
  });
  ipcMain.handle('companion:hooks-watch-state', (event) => {
    verifyPanel(event);
    return hookWatch?.snapshot() ?? null;
  });
  ipcMain.handle('companion:hooks-repair', async (event) => {
    verifyPanel(event);
    if (!hookWatch) return { ok: false, error: '自检还没启动。' };
    const record = await hookWatch.repair();
    return record.ok ? { ok: true } : { ok: false, error: record.error || '没装上。' };
  });
  ipcMain.handle('companion:hooks-consent', async (event, raw: unknown) => {
    verifyPanel(event);
    if (raw !== 'ask' && raw !== 'auto') return { ok: false, error: '参数无效。' };
    await hookWatch?.setConsent(raw);
    return { ok: true };
  });
  // 替你确认：开关与撤销只有面板能动；「学会」只来自你在对方弹窗里亲手点的批准。
  ipcMain.handle('companion:approvals-state', async (event) => {
    verifyPanel(event);
    return approvalStore?.view() ?? { enabled: false, grants: [], recent: [] };
  });
  ipcMain.handle('companion:approvals-enable', async (event, enabled: unknown) => {
    verifyPanel(event);
    if (typeof enabled !== 'boolean' || approvalStore === undefined) {
      return { ok: false, error: '参数无效。' };
    }
    await approvalStore.setEnabled(enabled);
    return { ok: true, view: approvalStore.view() };
  });
  ipcMain.handle('companion:approvals-revoke', async (event, raw: unknown) => {
    verifyPanel(event);
    const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const { source, project, key } = input;
    if (
      (source !== 'claude-code' && source !== 'workbuddy') ||
      typeof project !== 'string' ||
      typeof key !== 'string' ||
      approvalStore === undefined
    ) {
      return { ok: false, error: '参数无效。' };
    }
    await approvalStore.revoke({ source, project, key });
    return { ok: true, view: approvalStore.view() };
  });
  // 远程批准：开关与等待时长只有面板能改。
  ipcMain.handle('companion:remote-approve-state', (event) => {
    verifyPanel(event);
    return agentPermissions?.view() ?? null;
  });
  ipcMain.handle('companion:remote-approve-save', async (event, raw: unknown) => {
    verifyPanel(event);
    const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const { enabled, waitMs } = input;
    if (typeof enabled !== 'boolean' || !isWaitChoice(waitMs) || agentPermissions === undefined) {
      return { ok: false, error: '参数无效。' };
    }
    try {
      await agentPermissions.save({ enabled, waitMs });
    } catch {
      return { ok: false, error: '没保存上，请重试。' };
    }
    return { ok: true, config: agentPermissions.view() };
  });
  ipcMain.handle('companion:memory-enable', async (event, enabled: unknown) => {
    verifyPanel(event);
    if (typeof enabled !== 'boolean') return { ok: false, error: '参数无效。' };
    await memoryService.setEnabled(enabled);
    return { ok: true };
  });
  // 来源链接只能用系统浏览器打开：渲染进程本身禁止导航，
  // 这里也只接受 http/https，避免被 file:// 或自定义协议利用。
  ipcMain.handle('companion:open-external', async (event, raw: unknown) => {
    verify(event);
    if (typeof raw !== 'string' || raw.length > 2048) return { ok: false, error: '链接无效。' };
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, error: '链接无效。' };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { ok: false, error: '只允许打开 http 或 https 链接。' };
    }
    if (url.username !== '' || url.password !== '') {
      return { ok: false, error: '链接不能包含账号或密码。' };
    }
    await shell.openExternal(url.href);
    return { ok: true };
  });
  ipcMain.handle('companion:snapshot', (event) => {
    verify(event);
    return service.snapshot();
  });
  ipcMain.handle('companion:dispatch', (event, action: unknown) => {
    verify(event);
    touchPresence();
    return service.dispatch(action);
  });
  ipcMain.handle('companion:window', (event, action: unknown) => {
    const sender = verify(event);
    switch (action) {
      case 'panel':
        show(panel);
        break;
      case 'companion':
        show(companion);
        break;
      case 'hide':
        sender.hide();
        break;
      case 'quit':
        app.quit();
        break;
      default:
        throw new Error('不允许的窗口操作。');
    }
  });
  ipcMain.handle('companion:export', async (event) => {
    const sender = verify(event);
    await service.settled();
    if (service.snapshot().storageError)
      return { ok: false, error: '存储异常，请先检查原数据文件，避免导出不完整记录。' };
    const data = JSON.stringify(durableState(service.snapshot().state), null, 2);
    const selected = await dialog.showSaveDialog(sender, {
      title: '导出个人数据（不含模拟事件）',
      defaultPath: 'xinban-data.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (selected.canceled || !selected.filePath) return { ok: false };
    try {
      await writeFile(selected.filePath, data, 'utf8');
      return { ok: true };
    } catch {
      return { ok: false, error: '导出失败，请检查目标文件权限。' };
    }
  });
  ipcMain.handle('companion:export-mapping', async (event) => {
    const sender = verify(event);
    const selected = await dialog.showSaveDialog(sender, {
      title: '导出输入映射表（固定规格，不含个人数据）',
      defaultPath: 'xinban-input-mapping.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (selected.canceled || !selected.filePath) return { ok: false };
    try {
      await writeFile(selected.filePath, inputMappingReport(), 'utf8');
      return { ok: true };
    } catch {
      return { ok: false, error: '映射表导出失败，请检查目标文件权限。' };
    }
  });
  ipcMain.handle('companion:export-replay', async (event) => {
    const sender = verify(event);
    const text = replayScriptText(service.snapshot().state.simulation.events);
    if (!text) return { ok: false, error: '还没有模拟事件可导出。' };
    const selected = await dialog.showSaveDialog(sender, {
      title: '导出模拟回放脚本（不含个人数据）',
      defaultPath: 'xinban-replay.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (selected.canceled || !selected.filePath) return { ok: false };
    try {
      await writeFile(selected.filePath, text, 'utf8');
      return { ok: true };
    } catch {
      return { ok: false, error: '回放脚本导出失败，请检查目标文件权限。' };
    }
  });
  ipcMain.handle('companion:import-replay', async (event) => {
    const sender = verify(event);
    const selected = await dialog.showOpenDialog(sender, {
      title: '导入模拟回放脚本',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (selected.canceled || !selected.filePaths[0]) return { ok: false, error: '已取消导入。' };
    try {
      const info = await stat(selected.filePaths[0]);
      if (info.size > replayFileLimit) return { ok: false, error: '回放脚本文件过大。' };
      const parsed = parseReplayScript(await readFile(selected.filePaths[0], 'utf8'));
      if (!parsed.ok) return { ok: false, error: parsed.error };
      const result = await service.dispatch({ type: 'sim.script', events: parsed.events });
      return result.ok
        ? { ok: true, applied: parsed.events.length }
        : { ok: false, error: result.error };
    } catch {
      return { ok: false, error: '回放脚本读取失败，请检查文件权限。' };
    }
  });
  ipcMain.handle('companion:import', async (event) => {
    const sender = verify(event);
    const selected = await dialog.showOpenDialog(sender, {
      title: '导入个人数据（将覆盖当前数据）',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (selected.canceled || !selected.filePaths[0]) return { ok: false, error: '已取消导入。' };
    let raw: unknown;
    try {
      const info = await stat(selected.filePaths[0]);
      if (info.size > 2 * 1024 * 1024) return { ok: false, error: '数据文件过大。' };
      raw = JSON.parse(await readFile(selected.filePaths[0], 'utf8'));
    } catch {
      return { ok: false, error: '导入文件不是有效的 JSON，或无法读取。' };
    }
    const answer = await dialog.showMessageBox(sender, {
      type: 'warning',
      title: '导入将覆盖本地数据',
      message: '将用导入文件覆盖当前待办、计时、会话及设置。此操作不能撤销。',
      detail: '建议先导出备份。模拟事件与 AI 对话不在导入范围内。',
      buttons: ['取消', '导入并覆盖'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (answer.response !== 1) return { ok: false, error: '已取消导入。' };
    return service.import(raw);
  });
  ipcMain.handle('companion:clear', async (event) => {
    const sender = verify(event);
    const answer = await dialog.showMessageBox(sender, {
      type: 'warning',
      title: '清除本地个人数据',
      message: '将删除全部待办、计时、会话及设置。此操作不能撤销。',
      detail: '建议先导出备份。模拟事件也会重置；已导出的文件不会被删除。',
      buttons: ['取消', '清除数据'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return answer.response === 1 ? service.clear() : { ok: false, error: '已取消清除。' };
  });
  // 伙伴窗口专属：renderer 按鼠标所在区域请求透明区穿透。
  // 只接受布尔值、只接受伙伴窗口主 frame，不开放任意窗口控制。
  ipcMain.on('companion:mouse-passthrough', (event, ignore: unknown) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    if (
      !sender ||
      sender !== companion ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame.url !== windows.get(sender)
    )
      return;
    if (typeof ignore !== 'boolean') return;
    companion.setIgnoreMouseEvents(ignore, { forward: true });
    // 鼠标停到桌宠上：人在。
    if (!ignore) touchPresence();
  });
  Menu.setApplicationMenu(null);
  panel = createWindow('panel', null);
  companion = createWindow('companion', savedBounds);
  companion.setAlwaysOnTop(service.snapshot().state.settings.alwaysOnTop);
  let priorTimer = service.snapshot().state.timer?.status;
  let priorPet = service.snapshot().state.petUntil;
  let priorDone = new Map(service.snapshot().state.todos.map((todo) => [todo.id, todo.done]));
  service.subscribe((snapshot) => {
    broadcast('companion:updated', snapshot);
    const { state } = snapshot;
    if (companion.isAlwaysOnTop() !== state.settings.alwaysOnTop)
      companion.setAlwaysOnTop(state.settings.alwaysOnTop);
    if (state.timer?.status === 'completed' && priorTimer !== 'completed') {
      // 计时结束交给主动开口：小屏上亮卡，桌宠藏起来时自动补系统通知。
      proactiveService.focusDone(state.timer.durationMs / 60_000);
      proactiveService.offer({ kind: 'timer-done', key: `timer:${state.timer.id}` });
    }
    priorTimer = state.timer?.status;
    if (state.petUntil > priorPet) proactiveService.petted();
    priorPet = state.petUntil;
    const open = state.todos.filter((todo) => !todo.done).length;
    for (const todo of state.todos) {
      if (todo.done && priorDone.get(todo.id) === false) proactiveService.todoDone(open);
    }
    priorDone = new Map(state.todos.map((todo) => [todo.id, todo.done]));
    pushDeviceView();
  });
  // A self-contained 16 × 16 tray icon; no external image or branding.
  const pixels = Buffer.alloc(16 * 16 * 4);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const offset = (y * 16 + x) * 4;
      const eye = (x === 5 || x === 10) && y >= 5 && y <= 9;
      pixels[offset] = eye ? 50 : 106;
      pixels[offset + 1] = eye ? 58 : 212;
      pixels[offset + 2] = eye ? 45 : 167;
      pixels[offset + 3] = x > 0 && x < 15 && y > 0 && y < 15 ? 255 : 0;
    }
  tray = new Tray(nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }));
  tray.setToolTip('芯伴 · 本地桌面伙伴');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示伙伴', click: () => show(companion) },
      { label: '打开控制面板', click: () => show(panel) },
      { type: 'separator' },
      { label: '退出芯伴', click: () => app.quit() },
    ]),
  );
  tray.on('double-click', () => show(panel));
  let tickCount = 0;
  ticker = setInterval(() => {
    void service.tick();
    proactiveService.tick();
    tickCount += 1;
    // 待办到点：十五秒看一次就够，提醒晚十几秒没人察觉得到。
    if (tickCount % 15 === 0) {
      const { state } = service.snapshot();
      proactiveService.offerAll(dueTodoNudges(state.todos, state.now));
    }
    pushDeviceView();
  }, 1_000);
  // 用户启动了应用，人就在。
  touchPresence();
  app.on('activate', () => show(panel));
}

/** 屏上此刻的卡片与任务：手势意图的依据。 */
function gestureContext(): Parameters<typeof intentFor>[0] {
  const { state } = service.snapshot();
  return {
    confirmId: confirmService.snapshot().pending?.id ?? null,
    nudgeId: proactiveService.current()?.id ?? null,
    waitingTaskId: state.simulation.tasks.find((task) => task.status === 'waiting')?.id ?? null,
    timerRecovery: state.timer?.status === 'recovery',
  };
}

/**
 * 你对一张主动提醒的回应。接了且它有「可细说」的料，就替你问 AI 一句——
 * 这是你按下 A 触发的出站，不是它自己偷偷问的。
 */
function answerNudge(id: unknown, answer: unknown): { ok: boolean; error?: string } {
  const nudge = proactiveService.respond(id, answer);
  if (nudge === null) return { ok: false, error: '这条提醒已经收起来了。' };
  // 钩子丢了、你按了 A：就是同意重装（之后自动）。
  if (answer === 'accept' && nudge.kind === 'hooks-lost') {
    void hookWatch?.repair().catch(() => undefined);
    return { ok: true };
  }
  if (answer === 'accept' && nudge.askPrompt !== '') {
    const prompt = nudge.askPrompt;
    void aiService
      .status()
      .then((status) => (status.configured ? aiSession.send(prompt) : undefined))
      .catch(() => undefined);
  }
  return { ok: true };
}

/** 实体按键的意图落地。桌面按钮在渲染进程里走同一张表，结果经 IPC 回到这里的同一组入口。 */
function applyIntent(intent: GestureIntent): void {
  const { state } = service.snapshot();
  switch (intent.type) {
    case 'confirm-answer':
      // 实体小屏：放不下全文的请求只能在这里拒绝。
      confirmService.answerFromDevice(intent.id, intent.allow);
      return;
    case 'nudge-answer':
      answerNudge(intent.id, intent.accept ? 'accept' : 'dismiss');
      return;
    case 'sim-ack':
      void service.dispatch({ type: 'sim.acknowledge', taskId: intent.taskId });
      return;
    case 'interact':
      void service.dispatch({ type: 'pet.interact' });
      return;
    case 'quiet-toggle':
      void service.dispatch({ type: 'settings.patch', patch: { quiet: !state.settings.quiet } });
      return;
    // 小游戏只在桌面端；计时恢复要在面板确认；未分配的手势不产生动作。
    case 'game-toggle':
    case 'timer-recovery-hint':
    case 'unassigned':
      return;
  }
}

/** 算出小屏此刻该显示的内容，交给实体设备（未连接时只是记下）。 */
function pushDeviceView(): void {
  if (!deviceService || !service || !confirmService || !proactiveService) return;
  if (deviceService.snapshot().status === 'off') return;
  const { state } = service.snapshot();
  const confirm = confirmService.snapshot();
  const proactive = proactiveService.snapshot();
  const session = aiSession?.snapshot();
  const live = progressService?.snapshot().sessions.find((item) => item.status === 'working');
  const exchange = session ? lastExchange(session) : null;
  const now = Date.now();
  const bubble =
    proactive.petLine?.text ??
    (session?.busy
      ? '…'
      : exchange && now - replyShownAt < 20_000
        ? petExcerpt(exchange.answer).text
        : '');
  deviceService.setView(
    buildDeviceView({
      state,
      displayOptions: { idleLines: personaService.snapshot().idleLines },
      face: faceOf({
        mood: confirm.pending ? 'waiting' : 'idle',
        thinking: session?.busy === true,
      }),
      confirm: confirm.pending,
      confirmQueued: confirm.queued,
      nudge: proactive.current,
      work:
        workbench?.state().summary ||
        (live ? `${live.source ?? 'WorkBuddy'} · ${shortActivity(live)}` : ''),
      bubble,
    }),
  );
}

app.on('before-quit', (event) => {
  if (quitReady || !service) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  clearInterval(ticker);
  sttService?.stop();
  audioPlayer?.dispose();
  musicService?.dispose();
  progressService?.stop();
  hookWatch?.stop();
  agentPermissions?.stop();
  clearInterval(workbenchTimer);
  void usage?.flush();
  // 先删心跳：芯伴一退，钩子就不再替你批。
  const approvalsStopped = approvalStore?.stop();
  // 退出时取消进行中的对话：连带中止正在跑的命令/派活子进程，不留孤儿进程。
  confirmService?.cancelAll();
  // MCP 的子进程跟着芯伴一起退，不留孤儿。
  mcpService?.stopAll();
  aiSession?.cancel();
  delegateJob?.abort();
  void Promise.all([
    service.settled(),
    settleBounds(),
    memoryService?.settled(),
    proactiveService?.settled(),
    deviceService?.stop(),
    approvalsStopped,
    delegateService?.flushHistory(),
    appLog?.settled(),
    fileAccess?.settled(),
  ]).finally(() => {
    quitReady = true;
    tray?.destroy();
    app.quit();
  });
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (panel) show(panel);
  });
  void app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      dialog.showErrorBox('芯伴启动失败', String(error));
      app.quit();
    });
}
