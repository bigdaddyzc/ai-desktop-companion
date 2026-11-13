import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { CompanionBridge, Snapshot } from '../core/schema';
import type { AiSessionState } from '../core/ai-session';
import type { MemoryState } from '../core/memory';
import type { MemoryTidyState } from '../core/memory-tidy';
import type { PersonaConfig } from '../core/persona';
import type { WorkProgressState } from '../core/progress';
import type { SensesSnapshot } from '../core/senses';
import type { SttSnapshot } from '../core/stt';
import type { TtsSnapshot } from '../core/tts';
import type { VisionSnapshot } from '../core/vision';
import type { DelegateSnapshot } from '../core/delegate';
import type { HookWatchSnapshot } from '../core/hook-watch';
import type { HealthSnapshot } from '../core/app-log';
import type { FilesSnapshot } from '../core/file-roots';
import type { McpSnapshot } from '../core/mcp';
import type { VoiceConfig } from '../core/voice';
import type { ConfirmSnapshot } from '../core/confirm';
import type { ProactiveSnapshot } from '../core/proactive';
import type { MusicSnapshot } from '../core/music';
import type { DeviceSnapshot } from '../core/device-protocol';
import type { WorkbenchState } from '../core/workbench';
import type { LanScanState } from '../core/lan-scan';

/** 订阅一个主进程广播频道，返回取消函数。 */
function channel<T>(name: string, listener: (value: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(name, handler);
  return () => ipcRenderer.removeListener(name, handler);
}

const bridge: CompanionBridge = {
  snapshot: () => ipcRenderer.invoke('companion:snapshot'),
  dispatch: (action) => ipcRenderer.invoke('companion:dispatch', action),
  subscribe(listener) {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: Snapshot) => listener(snapshot);
    ipcRenderer.on('companion:updated', handler);
    return () => ipcRenderer.removeListener('companion:updated', handler);
  },
  windowAction: (action) => ipcRenderer.invoke('companion:window', action),
  mousePassthrough: (ignore) => ipcRenderer.send('companion:mouse-passthrough', ignore),
  exportData: () => ipcRenderer.invoke('companion:export'),
  importData: () => ipcRenderer.invoke('companion:import'),
  exportMapping: () => ipcRenderer.invoke('companion:export-mapping'),
  exportReplay: () => ipcRenderer.invoke('companion:export-replay'),
  importReplay: () => ipcRenderer.invoke('companion:import-replay'),
  clearData: () => ipcRenderer.invoke('companion:clear'),
  aiStatus: () => ipcRenderer.invoke('companion:ai-status'),
  aiConfigure: (input) => ipcRenderer.invoke('companion:ai-configure', input),
  aiClear: () => ipcRenderer.invoke('companion:ai-clear'),
  aiSession: () => ipcRenderer.invoke('companion:ai-session'),
  aiSend: (text, attachments) => ipcRenderer.invoke('companion:ai-send', text, attachments ?? []),
  attachPick: () => ipcRenderer.invoke('companion:attach-pick'),
  attachPaths: (paths) => ipcRenderer.invoke('companion:attach-paths', paths),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onAiSession(listener) {
    const handler = (_event: Electron.IpcRendererEvent, state: AiSessionState) => listener(state);
    ipcRenderer.on('companion:ai-session', handler);
    return () => ipcRenderer.removeListener('companion:ai-session', handler);
  },
  aiCancel: () => ipcRenderer.invoke('companion:ai-cancel'),
  delegateCancel: () => ipcRenderer.invoke('companion:delegate-cancel'),
  memoryState: () => ipcRenderer.invoke('companion:memory-state'),
  memoryRemove: (id) => ipcRenderer.invoke('companion:memory-remove', id),
  memoryClear: () => ipcRenderer.invoke('companion:memory-clear'),
  memoryEnable: (enabled) => ipcRenderer.invoke('companion:memory-enable', enabled),
  onMemoryState(listener) {
    const handler = (_event: Electron.IpcRendererEvent, state: MemoryState) => listener(state);
    ipcRenderer.on('companion:memory-state', handler);
    return () => ipcRenderer.removeListener('companion:memory-state', handler);
  },
  memoryTidyState: () => ipcRenderer.invoke('companion:memory-tidy-state'),
  memoryTidyStart: () => ipcRenderer.invoke('companion:memory-tidy-start'),
  memoryTidyApply: (actionIds) => ipcRenderer.invoke('companion:memory-tidy-apply', actionIds),
  memoryTidyDiscard: () => ipcRenderer.invoke('companion:memory-tidy-discard'),
  memoryTidyUndo: () => ipcRenderer.invoke('companion:memory-tidy-undo'),
  onMemoryTidyState(listener) {
    const handler = (_event: Electron.IpcRendererEvent, state: MemoryTidyState) => listener(state);
    ipcRenderer.on('companion:memory-tidy-state', handler);
    return () => ipcRenderer.removeListener('companion:memory-tidy-state', handler);
  },
  personaState: () => ipcRenderer.invoke('companion:persona-state'),
  personaSave: (config) => ipcRenderer.invoke('companion:persona-save', config),
  onPersonaState(listener) {
    const handler = (_event: Electron.IpcRendererEvent, config: PersonaConfig) => listener(config);
    ipcRenderer.on('companion:persona-state', handler);
    return () => ipcRenderer.removeListener('companion:persona-state', handler);
  },
  workState: () => ipcRenderer.invoke('companion:work-state'),
  workRefresh: () => ipcRenderer.invoke('companion:work-refresh'),
  workSourcesSave: (config) => ipcRenderer.invoke('companion:work-sources-save', config),
  hooksStatus: () => ipcRenderer.invoke('companion:hooks-status'),
  hooksApply: (target, action) => ipcRenderer.invoke('companion:hooks-apply', { target, action }),
  hooksWatchState: () => ipcRenderer.invoke('companion:hooks-watch-state'),
  hooksRepair: () => ipcRenderer.invoke('companion:hooks-repair'),
  hooksConsent: (consent) => ipcRenderer.invoke('companion:hooks-consent', consent),
  onHooksWatch(listener) {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: HookWatchSnapshot) =>
      listener(snapshot);
    ipcRenderer.on('companion:hooks-watch', handler);
    return () => ipcRenderer.removeListener('companion:hooks-watch', handler);
  },
  health: () => ipcRenderer.invoke('companion:health'),
  healthOpenLogs: () => ipcRenderer.invoke('companion:health-open-logs'),
  onHealth(listener) {
    const handler = (_event: Electron.IpcRendererEvent, health: HealthSnapshot) => listener(health);
    ipcRenderer.on('companion:health', handler);
    return () => ipcRenderer.removeListener('companion:health', handler);
  },
  filesState: () => ipcRenderer.invoke('companion:files-state'),
  filesAdd: (path, writable) => ipcRenderer.invoke('companion:files-add', path, writable),
  filesRemove: (name) => ipcRenderer.invoke('companion:files-remove', name),
  filesWritable: (name, writable) => ipcRenderer.invoke('companion:files-writable', name, writable),
  filesUndo: (id) => ipcRenderer.invoke('companion:files-undo', id),
  onFiles: (listener) => channel<FilesSnapshot>('companion:files-state', listener),
  mcpState: () => ipcRenderer.invoke('companion:mcp-state'),
  mcpSave: (input) => ipcRenderer.invoke('companion:mcp-save', input),
  mcpRemove: (name) => ipcRenderer.invoke('companion:mcp-remove', name),
  mcpEnable: (name, enabled) => ipcRenderer.invoke('companion:mcp-enable', name, enabled),
  mcpTrust: (name, trust) => ipcRenderer.invoke('companion:mcp-trust', name, trust),
  mcpToolTrust: (name, tool, trust) =>
    ipcRenderer.invoke('companion:mcp-tool-trust', name, tool, trust),
  mcpRestart: (name) => ipcRenderer.invoke('companion:mcp-restart', name),
  mcpImport: (source) => ipcRenderer.invoke('companion:mcp-import', source),
  onMcp: (listener) => channel<McpSnapshot>('companion:mcp-state', listener),
  approvalsState: () => ipcRenderer.invoke('companion:approvals-state'),
  approvalsEnable: (enabled) => ipcRenderer.invoke('companion:approvals-enable', enabled),
  remoteApproveState: () => ipcRenderer.invoke('companion:remote-approve-state'),
  workbenchState: () => ipcRenderer.invoke('companion:workbench-state'),
  workbenchSeen: (key) => ipcRenderer.invoke('companion:workbench-seen', key),
  workbenchReview: (key) => ipcRenderer.invoke('companion:workbench-review', key),
  workbenchDiff: (key) => ipcRenderer.invoke('companion:workbench-diff', key),
  workbenchOpen: (key) => ipcRenderer.invoke('companion:workbench-open', key),
  workbenchEditor: (editor) => ipcRenderer.invoke('companion:workbench-editor', editor),
  onWorkbench: (listener) => channel<WorkbenchState>('companion:workbench-state', listener),
  phonePushState: () => ipcRenderer.invoke('companion:phone-push-state'),
  phonePushSave: (input) => ipcRenderer.invoke('companion:phone-push-save', input),
  phonePushTest: () => ipcRenderer.invoke('companion:phone-push-test'),
  usageState: () => ipcRenderer.invoke('companion:usage-state'),
  lanScanState: () => ipcRenderer.invoke('companion:lan-scan-state'),
  lanScanStart: (subnet) => ipcRenderer.invoke('companion:lan-scan-start', subnet),
  onLanScan: (listener) => channel<LanScanState>('companion:lan-scan-state', listener),
  remoteApproveSave: (config) => ipcRenderer.invoke('companion:remote-approve-save', config),
  approvalsRevoke: (grant) =>
    ipcRenderer.invoke('companion:approvals-revoke', {
      source: grant.source,
      project: grant.project,
      key: grant.key,
    }),
  onWorkState(listener) {
    const handler = (_event: Electron.IpcRendererEvent, state: WorkProgressState) =>
      listener(state);
    ipcRenderer.on('companion:work-state', handler);
    return () => ipcRenderer.removeListener('companion:work-state', handler);
  },
  sensesState: () => ipcRenderer.invoke('companion:senses-state'),
  sensesSave: (config) => ipcRenderer.invoke('companion:senses-save', config),
  sensesReport: (reading) => ipcRenderer.send('companion:senses-report', reading),
  onSensesState(listener) {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: SensesSnapshot) =>
      listener(snapshot);
    ipcRenderer.on('companion:senses-state', handler);
    return () => ipcRenderer.removeListener('companion:senses-state', handler);
  },
  voiceState: () => ipcRenderer.invoke('companion:voice-state'),
  voiceSave: (config) => ipcRenderer.invoke('companion:voice-save', config),
  onVoiceState(listener) {
    const handler = (_event: Electron.IpcRendererEvent, config: VoiceConfig) => listener(config);
    ipcRenderer.on('companion:voice-state', handler);
    return () => ipcRenderer.removeListener('companion:voice-state', handler);
  },
  ttsState: () => ipcRenderer.invoke('companion:tts-state'),
  ttsStop: () => ipcRenderer.invoke('companion:tts-stop'),
  sttStop: () => ipcRenderer.invoke('companion:stt-stop'),
  ttsSpeak: (input) => ipcRenderer.invoke('companion:tts-speak', input),
  onTtsState(listener) {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: TtsSnapshot) =>
      listener(snapshot);
    ipcRenderer.on('companion:tts-state', handler);
    return () => ipcRenderer.removeListener('companion:tts-state', handler);
  },
  openExternal: (url) => ipcRenderer.invoke('companion:open-external', url),
  visionState: () => ipcRenderer.invoke('companion:vision-state'),
  visionSave: (config) => ipcRenderer.invoke('companion:vision-save', config),
  visionLook: (input) => ipcRenderer.invoke('companion:vision-look', input),
  onVisionState(listener) {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: VisionSnapshot) =>
      listener(snapshot);
    ipcRenderer.on('companion:vision-state', handler);
    return () => ipcRenderer.removeListener('companion:vision-state', handler);
  },
  delegateState: () => ipcRenderer.invoke('companion:delegate-state'),
  delegateSave: (config) => ipcRenderer.invoke('companion:delegate-save', config),
  delegateProbe: () => ipcRenderer.invoke('companion:delegate-probe'),
  onDelegateState(listener) {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: DelegateSnapshot) =>
      listener(snapshot);
    ipcRenderer.on('companion:delegate-state', handler);
    return () => ipcRenderer.removeListener('companion:delegate-state', handler);
  },
  onCaptureFrame(listener) {
    const handler = (_event: Electron.IpcRendererEvent, requestId: string) => listener(requestId);
    ipcRenderer.on('companion:capture-frame', handler);
    return () => ipcRenderer.removeListener('companion:capture-frame', handler);
  },
  sendCameraFrame: (requestId, frames) =>
    ipcRenderer.send('companion:camera-frame', requestId, frames),
  sttState: () => ipcRenderer.invoke('companion:stt-state'),
  sttSave: (input) => ipcRenderer.invoke('companion:stt-save', input),
  sttSaveKey: (input) => ipcRenderer.invoke('companion:stt-save-key', input),
  sttClearKey: () => ipcRenderer.invoke('companion:stt-clear-key'),
  sttTranscribe: (audio, mime) => ipcRenderer.invoke('companion:stt-transcribe', audio, mime),
  onSttState(listener) {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: SttSnapshot) =>
      listener(snapshot);
    ipcRenderer.on('companion:stt-state', handler);
    return () => ipcRenderer.removeListener('companion:stt-state', handler);
  },
  confirmState: () => ipcRenderer.invoke('companion:confirm-state'),
  confirmAnswer: (id, allow) => ipcRenderer.invoke('companion:confirm-answer', id, allow),
  confirmExternal: (id, action) => ipcRenderer.invoke('companion:confirm-external', id, action),
  onConfirmState: (listener) => channel<ConfirmSnapshot>('companion:confirm-state', listener),
  proactiveState: () => ipcRenderer.invoke('companion:proactive-state'),
  proactiveAnswer: (id, answer) => ipcRenderer.invoke('companion:proactive-answer', id, answer),
  proactiveSave: (config) => ipcRenderer.invoke('companion:proactive-save', config),
  onProactiveState: (listener) => channel<ProactiveSnapshot>('companion:proactive-state', listener),
  musicState: () => ipcRenderer.invoke('companion:music-state'),
  musicRefresh: () => ipcRenderer.invoke('companion:music-refresh'),
  musicControl: (command) => ipcRenderer.invoke('companion:music-control', command),
  onMusicState: (listener) => channel<MusicSnapshot>('companion:music-state', listener),
  deviceState: () => ipcRenderer.invoke('companion:device-state'),
  deviceSave: (config) => ipcRenderer.invoke('companion:device-save', config),
  iotSave: (config) => ipcRenderer.invoke('companion:iot-save', config),
  iotSet: (id, on) => ipcRenderer.invoke('companion:iot-set', id, on),
  deviceRefresh: () => ipcRenderer.invoke('companion:device-refresh'),
  deviceSimPress: (button, edge) => ipcRenderer.invoke('companion:device-sim-press', button, edge),
  onDeviceState: (listener) => channel<DeviceSnapshot>('companion:device-state', listener),
};
contextBridge.exposeInMainWorld('companion', bridge);
