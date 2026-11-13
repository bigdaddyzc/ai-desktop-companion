import { useEffect, useRef, useState, type FormEvent } from 'react';
import { aiDefaults, type AiStatus } from '../core/ai';
import { emptyAiSession, type AiSessionState } from '../core/ai-session';
import { emptyMemory, memoryCategoryLabels, type MemoryState } from '../core/memory';
import { MemoryTidy } from './MemoryTidy';
import { FilesCard } from './FilesCard';
import { McpCard } from './McpCard';
import { JobStatus } from './JobStatus';
import { FaceCard } from './FaceCard';
import { useFileDrop } from './useFileDrop';
import { attachmentLimits, sizeText, type AttachmentInfo } from '../core/attachments';
import {
  builtInIdleLines,
  defaultPersona,
  idleLineLimits,
  nicknameLimit,
  personaChoices,
  personaPresets,
  type PersonaConfig,
} from '../core/persona';
import { shortActivity, timeAgo } from '../core/progress';
import { channelLabel, type SensesConfig } from '../core/senses';
import { useSttSnapshot } from './useStt';
import { useWorkProgress } from './useWorkProgress';
import { useSensesSnapshot } from './useSensesState';
import {
  chooseVoice,
  defaultVoice,
  voiceLabel,
  voiceLimits,
  voicePacks,
  withEngine,
  withPack,
  type VoiceConfig,
} from '../core/voice';
import { cloudVoiceOf, cloudVoices } from '../core/tts';
import { defaultVision, visionLabel, visionModels, type VisionConfig } from '../core/vision';
import { useVisionState } from './useVisionState';
import {
  customBinProblem,
  defaultDelegate,
  delegateLabel,
  delegateLimits,
  delegateOutcomeLabels,
  delegateTargets,
  isPick,
  type DelegateConfig,
} from '../core/delegate';
import { rootProblem } from '../core/projects';
import { formatClock } from '../core/state';
import { useDelegateState } from './useDelegateState';
import { speakPreview, stopPreview, useTtsSnapshot, useVoices } from './useVoice';
import { useVoiceConfig } from './useVoiceConfig';

/**
 * 真实 AI 面板。
 *
 * 对话状态由主进程持有（AiSessionService），这里只是订阅者之一：
 * 在桌宠上提问、在面板上提问，看到的是同一段对话。
 * 对话只在本次运行的内存里；长期记忆单独持久化，并且在下面这一栏摊开给你看。
 */
export function AiPanel() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState<string>(aiDefaults.baseUrl);
  const [model, setModel] = useState<string>(aiDefaults.model);
  const [apiKey, setApiKey] = useState('');
  const [draft, setDraft] = useState('');
  // 待发的附件：已经复制进沙盒，发送时把 id 带上。
  const [attached, setAttached] = useState<AttachmentInfo[]>([]);
  const drop = useFileDrop(
    (items) => setAttached((current) => [...current, ...items].slice(-attachmentLimits.maxFiles)),
    (message) => setError(message),
  );
  const [session, setSession] = useState<AiSessionState>(() => emptyAiSession());
  const [memory, setMemory] = useState<MemoryState>(() => emptyMemory());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmMemory, setConfirmMemory] = useState(false);
  const [persona, setPersona] = useState<PersonaConfig>(() => ({ ...defaultPersona }));
  const [personaNotice, setPersonaNotice] = useState('');
  const [senseNotice, setSenseNotice] = useState('');
  const voices = useVoices();
  const savedVoice = useVoiceConfig();
  const tts = useTtsSnapshot();
  const [voiceDraft, setVoiceDraft] = useState<VoiceConfig>(() => defaultVoice());
  const [voiceNotice, setVoiceNotice] = useState('');
  /**
   * 只跟着**磁盘里的**配置走，不跟着草稿走。
   * 广播只在真的保存时来一次，所以调滑杆的中途不会被拽回旧值；
   * 另一个窗口改了嗓子，这边也会跟着更新。
   */
  const syncedVoice = useRef('');
  useEffect(() => {
    const key = JSON.stringify(savedVoice);
    if (key === syncedVoice.current) return;
    syncedVoice.current = key;
    setVoiceDraft(savedVoice);
  }, [savedVoice]);
  /**
   * 感官开关的乐观覆盖。
   *
   * 保存要跨进程走一趟磁盘，受控开关在这段时间里会弹回原状——用户点「关掉麦克风」
   * 却看见它还亮着，会以为没生效。所以先按点击更新界面，等广播回来的快照与它一致时清掉覆盖。
   * 失败则立刻回滚，并显示原因：宁可闪一下，也不能让界面长期撒谎。
   */
  const [senseOverride, setSenseOverride] = useState<Partial<SensesConfig> | null>(null);
  const work = useWorkProgress();
  const senses = useSensesSnapshot();
  const config: SensesConfig = { ...senses.config, ...senseOverride };
  // 视觉：和感官分开存。眼睛（帧差）管「有没有人在动」，这里管「画面里是什么」。
  const vision = useVisionState();
  const [visionDraft, setVisionDraft] = useState<VisionConfig>(() => ({ ...defaultVision }));
  const [visionNotice, setVisionNotice] = useState('');
  const [visionText, setVisionText] = useState('');
  const [visionBusy, setVisionBusy] = useState(false);
  /** 与语音同一个防拽回策略：只在保存成功后的广播里覆盖草稿。 */
  const syncedVision = useRef('');
  useEffect(() => {
    const key = JSON.stringify(vision.config);
    if (key === syncedVision.current) return;
    syncedVision.current = key;
    setVisionDraft(vision.config);
  }, [vision.config]);
  // 派活：授权状态 + 草稿。和视觉同一个防拽回策略。
  const delegated = useDelegateState();
  const [delegateDraft, setDelegateDraft] = useState<DelegateConfig>(() => ({
    ...defaultDelegate,
    customArgs: [],
  }));
  const [delegateNotice, setDelegateNotice] = useState('');
  const syncedDelegate = useRef('');
  useEffect(() => {
    const key = JSON.stringify(delegated.config);
    if (key === syncedDelegate.current) return;
    syncedDelegate.current = key;
    setDelegateDraft(delegated.config);
  }, [delegated.config]);
  // 语音转写：独立于感官。Key 只在保存时经过这里，存完立刻从 state 里擦掉。
  const stt = useSttSnapshot();
  const [sttKey, setSttKey] = useState('');
  useEffect(() => () => stopPreview(), []);
  const [sttNotice, setSttNotice] = useState('');
  /**
   * 和感官开关同一个坑，同一个解法：保存要跨进程走一趟磁盘，
   * 受控开关在这段时间里会弹回原状。先按点击更新，失败再回滚。
   */
  const [sttOverride, setSttOverride] = useState<boolean | null>(null);
  const sttEnabled = sttOverride ?? stt.config.enabled;
  useEffect(() => {
    setSttOverride(null);
  }, [stt.config.enabled]);
  useEffect(() => {
    setSenseOverride(null);
  }, [senses.config.ears, senses.config.eyes, senses.config.voice]);

  async function refresh() {
    try {
      setStatus(await window.companion!.aiStatus());
    } catch {
      setError('无法读取 AI 配置状态。');
    }
  }
  useEffect(() => {
    void refresh();
    // 先取一次快照，再订阅；顺序不能反，否则中间到达的更新会丢。
    void window.companion!.aiSession().then(setSession);
    void window.companion!.memoryState().then(setMemory);
    void window.companion!.personaState().then(setPersona);
    const offSession = window.companion!.onAiSession(setSession);
    const offMemory = window.companion!.onMemoryState(setMemory);
    const offPersona = window.companion!.onPersonaState(setPersona);
    return () => {
      offSession();
      offMemory();
      offPersona();
    };
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    try {
      const result = await window.companion!.aiConfigure({ baseUrl, model, apiKey });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setApiKey('');
      setNotice('凭据已用系统加密存储保存到本机，未写入项目文件。');
      await refresh();
    } catch {
      setError('配置保存未完成。');
    }
  }

  async function savePersona() {
    setError('');
    setPersonaNotice('');
    try {
      // 不带表情偏好：那一项归「表情」卡管，这里的草稿可能是旧的。
      const result = await window.companion!.personaSave({
        preset: persona.preset,
        nickname: persona.nickname,
        idleLines: persona.idleLines,
      });
      if (!result.ok) {
        setError(result.error ?? '性格设置没有保存成功。');
        return;
      }
      setPersonaNotice('已保存：下一句话换语气，屏幕上的字也是。');
    } catch {
      setError('性格设置没有保存成功。');
    }
  }

  async function saveVoice() {
    setError('');
    setVoiceNotice('');
    try {
      const result = await window.companion!.voiceSave(voiceDraft);
      setVoiceNotice(
        result.ok ? '已保存：下一句就用这个嗓子。' : (result.error ?? '没有保存成功。'),
      );
    } catch {
      setError('语音设置没有保存成功。');
    }
  }

  /**
   * 试听按**当前草稿**念，不是按已保存的配置：调完滑杆要能马上听见。
   * 云端那条会真的发一次请求（一句十几个字），合成失败就当场换系统嗓子里念。
   */
  async function previewVoice() {
    setVoiceNotice('正在准备…');
    try {
      const result = await speakPreview('我在呢。这句话能听出语气吗？', voiceDraft, setVoiceNotice);
      if (!result.ok) {
        setVoiceNotice(result.error ?? '这个环境没有可用的语音。');
        return;
      }
      setVoiceNotice(result.error ?? '已开始播放。没听到请检查系统音量。');
    } catch {
      setVoiceNotice('试听没有走通。');
    }
  }

  async function saveVision(): Promise<boolean> {
    setError('');
    setVisionNotice('');
    try {
      const result = await window.companion!.visionSave(visionDraft);
      if (!result.ok) {
        setVisionNotice(result.error ?? '没有保存成功。');
        return false;
      }
      setVisionNotice('已保存：它下一句话就知道自己能不能看。');
      return true;
    } catch {
      setVisionNotice('眼力设置没有保存成功。');
      return false;
    }
  }

  /**
   * 当场看一眼。
   *
   * 先把草稿存下去再截：开关还没落盘就去看，主进程那边读到的仍是「没允许」，
   * 用户看到的就是「打开了却说没权限」这种自相矛盾的提示。
   */
  async function look(source: 'screen' | 'camera') {
    setVisionNotice('');
    setVisionText('');
    setVisionBusy(true);
    try {
      const saved = await window.companion!.visionSave(visionDraft);
      if (!saved.ok) {
        setVisionNotice(saved.error ?? '开关没保存成功，先保存再看。');
        return;
      }
      const result = await window.companion!.visionLook({ source });
      if (!result.ok) {
        setVisionNotice(result.error ?? '这次没看到。');
        return;
      }
      setVisionText(result.text ?? '');
      setVisionNotice('');
    } catch {
      setVisionNotice('看画面没有走通。');
    } finally {
      setVisionBusy(false);
    }
  }

  /**
   * 保存委派授权。
   *
   * 自定义命令在这里先做同一个校验：带 `&&`、`|` 的整行贴进来会被拒，
   * 否则它会被当成一个文件名，然后在 cmd 里被拆开执行。
   */
  async function saveDelegate(): Promise<void> {
    setDelegateNotice('');
    const badRoot = rootProblem(delegateDraft.projectsRoot.trim());
    if (badRoot !== '') {
      setDelegateNotice(`项目根目录：${badRoot}`);
      return;
    }
    if (delegateDraft.target === 'custom') {
      const problem = customBinProblem(delegateDraft.customBin);
      if (problem !== '') {
        setDelegateNotice(problem);
        return;
      }
    }
    try {
      const result = await window.companion!.delegateSave(delegateDraft);
      if (!result.ok) {
        setDelegateNotice(result.error ?? '没有保存成功。');
        return;
      }
      setDelegateNotice(
        delegateDraft.allowAgents || delegateDraft.allowShell
          ? '已保存：它下一句话就知道自己能派活、能跑命令。'
          : '已保存：两项都关着，它不会派活也不会跑命令。',
      );
    } catch {
      setDelegateNotice('委派设置没有保存成功。');
    }
  }

  async function probeDelegate(): Promise<void> {
    setDelegateNotice('');
    try {
      await window.companion!.delegateProbe();
      setDelegateNotice('已重新探测。');
    } catch {
      setDelegateNotice('探测没有走通。');
    }
  }

  async function toggleSense(key: keyof SensesConfig, value: boolean) {
    setError('');
    setSenseNotice('');
    const next = { ...config, [key]: value };
    setSenseOverride((current) => ({ ...current, [key]: value }));
    try {
      const result = await window.companion!.sensesSave(next);
      if (!result.ok) {
        setSenseOverride(null);
        setError(result.error ?? '开关没有保存成功。');
      }
    } catch {
      setSenseOverride(null);
      setError('开关没有保存成功。');
    }
  }

  async function toggleStt(value: boolean) {
    setError('');
    setSttNotice('');
    setSttOverride(value);
    try {
      const result = await window.companion!.sttSave({ enabled: value });
      if (!result.ok) {
        setSttOverride(null);
        setError(result.error ?? '开关没有保存成功。');
      }
    } catch {
      setSttOverride(null);
      setError('开关没有保存成功。');
    }
  }

  async function saveSttKey(event: FormEvent) {
    event.preventDefault();
    const key = sttKey.trim();
    if (key === '') return;
    setError('');
    setSttNotice('');
    try {
      const result = await window.companion!.sttSaveKey({ apiKey: key });
      if (!result.ok) {
        setError(result.error ?? 'Key 没有保存成功。');
        return;
      }
      // 存完就从组件里擦掉：它已经在系统加密存储里，没必要继续留在界面的内存里。
      setSttKey('');
      setSttNotice('Key 存好了。去小屏上按住「◉ 按住说」试一句。');
    } catch {
      setError('Key 没有保存成功。');
    }
  }

  async function clearSttKey() {
    setError('');
    setSttNotice('');
    try {
      await window.companion!.sttClearKey();
      setSttNotice('Key 已经清掉，语音输入暂时用不了。');
    } catch {
      setError('没能清掉 Key。');
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const files = attached;
    const text = draft.trim() || (files.length > 0 ? '帮我看看这些文件。' : '');
    if (!text || session.busy || !status?.configured) return;
    setDraft('');
    setAttached([]);
    setError('');
    try {
      const result = await window.companion!.aiSend(
        text,
        files.map((item) => item.id),
      );
      if (!result.ok) setError(result.error);
      await refresh();
    } catch {
      setError('AI 请求未完成。');
    }
  }

  async function cancel() {
    try {
      await window.companion!.aiCancel();
    } catch {
      setError('取消未完成。');
    }
  }

  async function clear() {
    try {
      const result = await window.companion!.aiClear();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice('已清除本机保存的 API Key。');
      setConfirmClear(false);
      await refresh();
    } catch {
      setError('清除未完成。');
    }
  }

  async function openLink(url: string) {
    try {
      const result = await window.companion!.openExternal(url);
      if (!result.ok) setError(result.error ?? '链接无法打开。');
    } catch {
      setError('链接无法打开。');
    }
  }

  async function dropFact(id: string) {
    setError('');
    try {
      const result = await window.companion!.memoryRemove(id);
      if (!result.ok) setError(result.error ?? '删除未完成。');
    } catch {
      setError('删除未完成。');
    }
  }

  async function clearMemory() {
    setError('');
    try {
      const result = await window.companion!.memoryClear();
      if (!result.ok) {
        setError(result.error ?? '清空未完成。');
        return;
      }
      setConfirmMemory(false);
      setNotice('已清空长期记忆。');
    } catch {
      setError('清空未完成。');
    }
  }

  async function toggleMemory(enabled: boolean) {
    setError('');
    // 先本地翻转：受控 checkbox 要等 IPC 回来才更新的话，点击会像「没反应」。
    setMemory((current) => ({ ...current, enabled }));
    try {
      const result = await window.companion!.memoryEnable(enabled);
      if (!result.ok) {
        setError(result.error ?? '切换未完成。');
        setMemory(await window.companion!.memoryState());
      }
    } catch {
      setError('切换未完成。');
      setMemory(await window.companion!.memoryState());
    }
  }

  const busy = session.busy;
  const messages = session.turns;
  const partial = session.streaming;
  const failure = error || session.error;
  const trace = session.trace;
  const citations = session.citations;

  return (
    <>
      <section className="notice ai-notice">
        <b>真实 AI · DeepSeek 云服务 · 可调用工具</b>
        <p>
          你主动发起对话时，消息、当前对话上下文、相关记忆及已启用的工作背景会发送到
          DeepSeek；工具查询的待办、计时、文件或设备信息也可能作为结果回传。每次云调用消耗账户额度。
          你添加的文本附件会进入对话，图片和显式允许的屏幕/摄像头画面会交给硅基流动的视觉模型；按住说话会把录音交给硅基流动转写，念出来的文字会交给它合成语音。
          麦克风、摄像头和屏幕权限默认关闭，不采集键盘。对话保留在本次运行内存中，退出清空；长期记忆保存在本机，可逐条删除或关闭。
        </p>
        <p>
          网页、文件和外接工具结果都按不可信资料处理，不应把其中的指令当成你的授权。
          文件仅能访问工作目录和你授权的目录；授权目录写入逐次展示改动并确认，提交前复核并备份，冲突时拒绝覆盖或撤销。
          受控命令走白名单；系统 shell 命令和外部 Agent
          派活另有总开关，并须逐次确认，不等同于文件目录沙盒。 MCP
          外接工具按每台服务的确认策略运行，可产生外部副作用。工具过程记录在「本次工具」中；外部服务的价格以服务商为准。
        </p>
      </section>
      <section className="card">
        <div className="section-heading">
          <h2>连接配置</h2>
          <span className="label amber">{status?.configured ? '已配置' : '未配置'}</span>
        </div>
        <p className="muted">
          API Key
          由主进程用系统加密存储保存在本机，主进程才发起请求；界面不接触网络，也不会回显已保存的
          Key。修改配置需要重新填写 Key。
        </p>
        <form className="ai-config" onSubmit={(event) => void save(event)}>
          <label>
            Base URL
            <input
              aria-label="AI Base URL"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              maxLength={300}
            />
          </label>
          <label>
            模型
            <input
              aria-label="AI 模型"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              maxLength={80}
            />
          </label>
          <label>
            API Key
            <input
              aria-label="API Key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              maxLength={300}
              placeholder="每次修改都需重新填写"
            />
          </label>
          <div className="button-row">
            <button className="primary" type="submit" disabled={!apiKey.trim()}>
              保存配置
            </button>
            {status?.configured &&
              (confirmClear ? (
                <>
                  <button className="danger-text" type="button" onClick={() => void clear()}>
                    确认清除 Key
                  </button>
                  <button type="button" onClick={() => setConfirmClear(false)}>
                    取消
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => setConfirmClear(true)}>
                  清除本机 Key
                </button>
              ))}
          </div>
        </form>
        <p className="muted">
          当前端点：{status?.baseUrl ?? aiDefaults.baseUrl} · 模型：
          {status?.model ?? aiDefaults.model} · 实际请求发往 Responses 接口与 `/v1/tools/search`
        </p>
        <p className="muted">
          本次运行累计：{status?.usage.requests ?? 0} 次模型请求 · {status?.usage.totalTokens ?? 0}{' '}
          tokens · {status?.toolCalls ?? 0} 次工具调用（仅内存统计，重启清零， 不含费用换算）。
        </p>
      </section>
      <section className="card" data-testid="ai-persona">
        <div className="section-heading">
          <h2>它什么脾气</h2>
          <span className="label">{personaPresets[persona.preset].label}</span>
        </div>
        <p className="muted">
          性格只改说话方式，不改它能做什么，也不放松任何限制。改完下一句就生效，不用重启。
        </p>
        <div className="persona-grid" role="radiogroup" aria-label="性格">
          {personaChoices().map((choice) => {
            const active = persona.preset === choice.value;
            return (
              <button
                key={choice.value}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`persona-${choice.value}`}
                className={active ? 'persona-option active' : 'persona-option'}
                onClick={() => {
                  setPersona((current) => ({ ...current, preset: choice.value }));
                  setPersonaNotice('');
                }}
              >
                <strong>{choice.label}</strong>
                <small>{choice.hint}</small>
              </button>
            );
          })}
        </div>
        <label className="persona-name">
          怎么叫你（可留空）
          <input
            aria-label="它怎么叫你"
            value={persona.nickname}
            maxLength={nicknameLimit}
            placeholder="留空就直接说事"
            onChange={(event) => {
              setPersona((current) => ({ ...current, nickname: event.target.value }));
              setPersonaNotice('');
            }}
          />
        </label>
        <label className="persona-name persona-lines">
          屏幕闲时说什么（一行一句，最多 {idleLineLimits.count} 句，留空用默认）
          <textarea
            aria-label="屏幕闲时标语"
            rows={3}
            maxLength={200}
            value={persona.idleLines.join('\n')}
            placeholder={builtInIdleLines.join('\n')}
            onChange={(event) => {
              setPersona((current) => ({
                ...current,
                // 空行交给保存时的 normalize 去掉，这里不做过早清理，
                // 否则用户在两个词之间敲回车，光标会跳。
                idleLines: event.target.value.split('\n'),
              }));
              setPersonaNotice('');
            }}
          />
        </label>
        <p className="muted persona-hint">
          这几句只在没有待办、没有计时的时候出现，每二十秒换一句。 写长了会被截到{' '}
          {idleLineLimits.chars} 个字——小屏一行就那么宽。
        </p>
        <div className="button-row">
          <button className="primary" type="button" onClick={() => void savePersona()}>
            保存性格与标语
          </button>
          {personaNotice !== '' && <span className="muted">{personaNotice}</span>}
        </div>
      </section>
      <section className="card" data-testid="ai-voice">
        <div className="section-heading">
          <h2>它的声音</h2>
          <span className="label">{voiceLabel(voiceDraft)}</span>
        </div>
        <p className="muted">
          云端那把嗓子是硅基流动的
          CosyVoice2：真人说话的起伏和气口都在，代价是要联网、要走一点额度，
          每句多等一两秒。系统语音不联网、不花钱，但只有一个词一个词往外蹦的机械感。
          换完下一句话就生效；勿扰时不出声，你一开口它就停。只念定稿的那一句，流式的半句话不念。
        </p>
        <label className="switch-row">
          <input
            type="checkbox"
            aria-label="让它念出来"
            checked={config.voice}
            onChange={(event) => void toggleSense('voice', event.target.checked)}
          />
          让它念出来（回复直接用语音播出来）
        </label>
        <div className="voice-engines" role="radiogroup" aria-label="声音来源">
          <button
            type="button"
            role="radio"
            aria-checked={voiceDraft.engine === 'cloud'}
            data-testid="voice-engine-cloud"
            className={`voice-pack${voiceDraft.engine === 'cloud' ? ' active' : ''}`}
            onClick={() => {
              setVoiceDraft((current) => withEngine(current, 'cloud'));
              setVoiceNotice('');
            }}
          >
            <b>云端自然音</b>
            <small>
              {tts.status === 'ready' ? 'CosyVoice2 · 像真人说话' : 'CosyVoice2 · 还没填 Key'}
            </small>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={voiceDraft.engine === 'system'}
            data-testid="voice-engine-system"
            className={`voice-pack${voiceDraft.engine === 'system' ? ' active' : ''}`}
            onClick={() => {
              setVoiceDraft((current) => withEngine(current, 'system'));
              setVoiceNotice('');
            }}
          >
            <b>系统语音</b>
            <small>离线 · 不花钱 · 语调偏机械</small>
          </button>
        </div>
        {voiceDraft.engine === 'cloud' && (
          <div className="cloud-voices" role="radiogroup" aria-label="云端音色">
            {cloudVoices.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={voiceDraft.cloudVoice === item.id}
                data-testid={`cloud-voice-${item.id}`}
                className={`voice-pack${voiceDraft.cloudVoice === item.id ? ' active' : ''}`}
                onClick={() => {
                  setVoiceDraft((current) => ({ ...current, cloudVoice: item.id }));
                  setVoiceNotice('');
                }}
              >
                <b>{item.label}</b>
                <small>{item.desc}</small>
              </button>
            ))}
          </div>
        )}
        <div className="voice-packs" role="radiogroup" aria-label="语音包">
          {voicePacks.map((pack) => (
            <button
              key={pack.id}
              type="button"
              role="radio"
              aria-checked={voiceDraft.pack === pack.id}
              data-testid={`voice-pack-${pack.id}`}
              className={`voice-pack${voiceDraft.pack === pack.id ? ' active' : ''}`}
              onClick={() => {
                setVoiceDraft((current) => withPack(current, pack.id));
                setVoiceNotice('');
              }}
            >
              <b>{pack.name}</b>
              <small>{pack.desc}</small>
            </button>
          ))}
        </div>
        {voiceDraft.engine === 'system' && (
          <label className="voice-row">
            <span>音色</span>
            <select
              aria-label="系统音色"
              value={voiceDraft.voiceURI}
              onChange={(event) => {
                setVoiceDraft((current) => ({ ...current, voiceURI: event.target.value }));
                setVoiceNotice('');
              }}
            >
              <option value="">自动挑一个中文语音</option>
              {voices.map((item) => (
                <option key={item.voiceURI} value={item.voiceURI}>
                  {item.name}
                  {item.localService ? '' : '（需联网）'}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="voice-row">
          <span>语速</span>
          <input
            type="range"
            aria-label="语速"
            min={voiceLimits.rate.min}
            max={voiceLimits.rate.max}
            step={0.02}
            value={voiceDraft.rate}
            onChange={(event) =>
              setVoiceDraft((current) => ({ ...current, rate: Number(event.target.value) }))
            }
          />
          <b>{voiceDraft.rate.toFixed(2)}×</b>
        </label>
        {voiceDraft.engine === 'system' && (
          <label className="voice-row">
            <span>音调</span>
            <input
              type="range"
              aria-label="音调"
              min={voiceLimits.pitch.min}
              max={voiceLimits.pitch.max}
              step={0.02}
              value={voiceDraft.pitch}
              onChange={(event) =>
                setVoiceDraft((current) => ({ ...current, pitch: Number(event.target.value) }))
              }
            />
            <b>{voiceDraft.pitch.toFixed(2)}</b>
          </label>
        )}
        <div className="button-row">
          <button type="button" onClick={() => void previewVoice()}>
            试听这句
          </button>
          <button className="primary" type="button" onClick={() => void saveVoice()}>
            保存声音
          </button>
          <span className="muted" data-testid="voice-resolved">
            {voiceDraft.engine === 'cloud'
              ? `云端：${cloudVoiceOf(voiceDraft.cloudVoice).label}${
                  tts.status === 'ready' ? '' : '（缺 Key，现在会用系统语音）'
                }`
              : `系统：${chooseVoice(voices, voiceDraft.voiceURI)?.name ?? '默认'}`}
          </span>
        </div>
        {voiceNotice !== '' && <p className="muted">{voiceNotice}</p>}
      </section>
      <section className="card" data-testid="ai-senses">
        <div className="section-heading">
          <h2>它的耳朵和眼睛</h2>
          <span className="label">
            {[config.ears ? '听' : '', config.eyes ? '看' : '']
              .filter((item) => item !== '')
              .join(' · ') || '都没开'}
          </span>
        </div>
        <p className="muted">
          麦克风只算音量：不录音、不转文字、不落盘。摄像头只把画面缩到 64×48 算帧差，
          只知道「有没有人在动」，画面不保存也不上传。关掉开关，系统里的设备指示灯会立刻熄灭。
        </p>
        <label className="switch-row">
          <input
            type="checkbox"
            aria-label="让它听见"
            checked={config.ears}
            onChange={(event) => void toggleSense('ears', event.target.checked)}
          />
          让它听见（麦克风）
        </label>
        <label className="switch-row">
          <input
            type="checkbox"
            aria-label="让它看见"
            checked={config.eyes}
            onChange={(event) => void toggleSense('eyes', event.target.checked)}
          />
          让它看见（摄像头）
        </label>
        <div className="sense-status" data-testid="senses-status">
          <p>
            <b>麦克风</b>
            <span data-testid="sense-mic">{channelLabel(senses.reading.mic)}</span>
            <i className="sense-meter" aria-hidden="true">
              <span style={{ width: `${Math.round(senses.reading.level * 100)}%` }} />
            </i>
            <small>
              {senses.reading.mic === 'live'
                ? senses.reading.speaking
                  ? '你在说话'
                  : '没声音'
                : '—'}
            </small>
          </p>
          <p>
            <b>摄像头</b>
            <span data-testid="sense-camera">{channelLabel(senses.reading.camera)}</span>
            <small>
              {senses.reading.camera === 'live'
                ? senses.reading.present
                  ? '画面里有人'
                  : '有一阵没看到人'
                : '—'}
            </small>
          </p>
          {senses.reading.error !== '' && <p className="sense-error">{senses.reading.error}</p>}
        </div>
        {senseNotice !== '' && <p className="muted">{senseNotice}</p>}
      </section>
      <section className="card" data-testid="ai-vision">
        <div className="section-heading">
          <h2>它的眼睛（看画面）</h2>
          <span className="label">{visionLabel(visionDraft)}</span>
        </div>
        {/*
          这张卡要解释清楚一件容易误会的事：模型本身看不见像素，
          「能看」是靠一次截图 + 一次视觉模型转述换来的，不是实时视频。
        */}
        <p className="muted">
          它自己是个文字模型，看不见画面。打开这里的开关后，它可以在需要时「看一眼」：
          截取画面（屏幕一帧、摄像头对焦后连拍五帧，画面没动就少发几张）交给硅基流动的视觉模型，
          换回一段文字描述，再由它自己接着推理。
          图只在内存里过一趟，不落盘、不存历史；摄像头会亮一下指示灯，拍完立刻关。
        </p>
        <label className="switch-row">
          <input
            type="checkbox"
            aria-label="允许它看屏幕"
            data-testid="vision-allow-screen"
            checked={visionDraft.allowScreen}
            onChange={(event) => {
              setVisionDraft((current) => ({ ...current, allowScreen: event.target.checked }));
              setVisionNotice('');
            }}
          />
          允许它看屏幕（你说「这个报错什么意思」时用得上）
        </label>
        <label className="switch-row">
          <input
            type="checkbox"
            aria-label="允许它看摄像头"
            data-testid="vision-allow-camera"
            checked={visionDraft.allowCamera}
            onChange={(event) => {
              setVisionDraft((current) => ({ ...current, allowCamera: event.target.checked }));
              setVisionNotice('');
            }}
          />
          允许它看摄像头（对焦后连拍五帧，看清比快重要）
        </label>
        <label className="voice-row">
          <span>视觉模型</span>
          <select
            aria-label="视觉模型"
            data-testid="vision-model"
            value={visionDraft.model}
            onChange={(event) => {
              setVisionDraft((current) => ({ ...current, model: event.target.value }));
              setVisionNotice('');
            }}
          >
            {visionModels.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label} · {item.desc}
              </option>
            ))}
          </select>
        </label>
        <div className="button-row">
          <button type="button" disabled={visionBusy} onClick={() => void look('screen')}>
            看一眼屏幕
          </button>
          <button type="button" disabled={visionBusy} onClick={() => void look('camera')}>
            看一眼我
          </button>
          <button className="primary" type="button" onClick={() => void saveVision()}>
            保存眼力
          </button>
          <span className="muted" data-testid="vision-status">
            {vision.status === 'ready'
              ? `${visionModels.find((item) => item.id === visionDraft.model)?.label ?? '视觉模型'} · 用语音那把 Key`
              : '缺 Key（和「听懂你说话」共用同一把硅基流动 Key）'}
          </span>
        </div>
        {visionText !== '' && (
          <div className="vision-result" data-testid="vision-result">
            <b>它看到的</b>
            <span>{visionText}</span>
          </div>
        )}
        {vision.lastError !== '' && visionText === '' && (
          <p className="sense-error">{vision.lastError}</p>
        )}
        {visionNotice !== '' && <p className="muted">{visionNotice}</p>}
      </section>
      {/*
        这张卡是整个应用里第一次把「动手权」交出去，所以说明要写足：
        它会改文件、会执行命令，而且这两件事都不是在沙箱里发生的。
      */}
      <section className="card" data-testid="ai-delegate">
        <div className="section-heading">
          <h2>替它派活（外包与命令）</h2>
          <span className="label">{delegateLabel(delegateDraft)}</span>
        </div>
        <p className="muted">
          打开下面两项后，它可以把一整件事交给这台电脑上已经装好的 AI Agent （WorkBuddy / Claude
          Code / Codex）——对方会自己读代码、改文件、反复试错，干完把结论交回来；
          也可以直接跑一条系统命令（构建、装依赖、跑测试）。
          <br />
          WorkBuddy 用的是 CodeBuddy 命令行，和桌面版是两份凭据：第一次用之前，在终端里跑一次
          codebuddy --port 0（桌面版占着默认端口），进去输入 /login。
          <br />
          这两项都<b>会真的改你的文件</b>：外包走的 Agent 在自己的沙箱里干活，系统命令会经过
          shell，危险动作（删盘、改注册表、强推、下载即执行等）在执行前被拦下，但黑名单
          <b>不是沙箱</b>——拦得住看得出来的，拦不住绕着来的。所以授权一次就长期有效，
          派了什么、跑了什么都会出现在对话的工具轨迹里，随时可以点取消让它停下。
        </p>
        <label className="switch-row">
          <input
            type="checkbox"
            aria-label="允许它把活外包给 AI Agent"
            data-testid="delegate-allow-agents"
            checked={delegateDraft.allowAgents}
            onChange={(event) => {
              setDelegateDraft((current) => ({ ...current, allowAgents: event.target.checked }));
              setDelegateNotice('');
            }}
          />
          允许它把活外包给本机的 AI Agent
        </label>
        <label className="switch-row">
          <input
            type="checkbox"
            aria-label="允许它运行系统命令"
            data-testid="delegate-allow-shell"
            checked={delegateDraft.allowShell}
            onChange={(event) => {
              setDelegateDraft((current) => ({ ...current, allowShell: event.target.checked }));
              setDelegateNotice('');
            }}
          />
          允许它运行系统命令（构建、装依赖、跑测试）
        </label>
        <label className="voice-row">
          <span>派给</span>
          <select
            aria-label="外包给谁"
            data-testid="delegate-target"
            value={delegateDraft.target}
            onChange={(event) => {
              const value = event.target.value;
              setDelegateDraft((current) => ({
                ...current,
                target: isPick(value) ? value : defaultDelegate.target,
              }));
              setDelegateNotice('');
            }}
          >
            <option value="auto">
              自动挑 · 按任务选，拿不准按 Claude Code → Codex → WorkBuddy
            </option>
            {delegateTargets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.label} · {target.desc}
              </option>
            ))}
            <option value="custom">自定义命令 · 自己在下面填</option>
          </select>
        </label>
        <label className="switch-row">
          <input
            type="checkbox"
            aria-label="挑中的不可用时自动换一个"
            data-testid="delegate-fallback"
            checked={delegateDraft.fallback}
            onChange={(event) => {
              setDelegateDraft((current) => ({ ...current, fallback: event.target.checked }));
              setDelegateNotice('');
            }}
          />
          挑中的不可用（没装、没登录、模型服务出错）时自动换一个。干了但没干成、超时不换，免得重复改文件
        </label>
        <label className="voice-row">
          <span>限时</span>
          <select
            aria-label="派活最长等待时间"
            data-testid="delegate-timeout"
            value={delegateDraft.timeoutMinutes}
            onChange={(event) => {
              setDelegateDraft((current) => ({
                ...current,
                timeoutMinutes: Number(event.target.value),
              }));
              setDelegateNotice('');
            }}
          >
            {delegateLimits.timeoutChoices.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes} 分钟
              </option>
            ))}
          </select>
        </label>
        <p className="muted">
          外部 Agent
          是黑盒：卡在权限确认、死循环或网络挂起时不会自己回来，没有上限它就会一直占着芯伴。
          但不能不限时。改代码加跑测试通常要 5–20 分钟，默认 10
          分钟；超时会把它停掉，并把已经跑出来的部分结果交回来。
        </p>
        <label className="voice-row">
          <span>我的项目</span>
          <input
            aria-label="项目根目录"
            data-testid="delegate-projects-root"
            placeholder="例如 D:\\claude-workspace（其下每个文件夹是一个项目；留空不登记）"
            value={delegateDraft.projectsRoot}
            onChange={(event) => {
              setDelegateDraft((current) => ({ ...current, projectsRoot: event.target.value }));
              setDelegateNotice('');
            }}
          />
        </label>
        <p className="muted" data-testid="delegate-projects">
          {delegated.projectsError !== ''
            ? delegated.projectsError
            : delegated.projects.length === 0
              ? '没有登记项目：派出去的活都在芯伴自己的工作目录里干。'
              : `登记了 ${delegated.projects.length} 个项目：${delegated.projects
                  .map((item) => item.name)
                  .join('、')}。说「把 X 项目的 bug 交给 Claude」，它就在那个文件夹里干。`}
        </p>
        {delegateDraft.target === 'custom' && (
          <>
            <label className="voice-row">
              <span>命令</span>
              <input
                aria-label="自定义命令"
                data-testid="delegate-custom-bin"
                placeholder="例如 C:\\tools\\my-agent.cmd"
                value={delegateDraft.customBin}
                onChange={(event) => {
                  setDelegateDraft((current) => ({ ...current, customBin: event.target.value }));
                  setDelegateNotice('');
                }}
              />
            </label>
            <label className="voice-row">
              <span>参数</span>
              <input
                aria-label="自定义参数"
                data-testid="delegate-custom-args"
                placeholder="空格分隔；写 {task} 表示把任务拼进参数（不写则走 stdin）"
                value={delegateDraft.customArgs.join(' ')}
                onChange={(event) => {
                  const args = event.target.value
                    .split(/\s+/)
                    .map((item) => item.trim())
                    .filter((item) => item !== '');
                  setDelegateDraft((current) => ({ ...current, customArgs: args }));
                  setDelegateNotice('');
                }}
              />
            </label>
          </>
        )}
        <div className="button-row">
          <button className="primary" type="button" onClick={() => void saveDelegate()}>
            保存授权
          </button>
          <button type="button" onClick={() => void probeDelegate()}>
            重新探测
          </button>
          <span className="muted" data-testid="delegate-status">
            {delegated.status === 'ready'
              ? '命令已就绪'
              : delegated.status === 'missing'
                ? '没探测到这个命令'
                : '两项都关着'}
          </span>
        </div>
        <ul className="muted" data-testid="delegate-targets">
          {delegated.targets.map((target) => (
            <li key={target.id}>
              {target.label}：{target.available ? target.path : '没找到'}
            </li>
          ))}
        </ul>
        {delegated.lastTask !== '' && (
          <p className="muted">
            上一次派给它：{delegated.lastTask}
            {delegated.busy ? '（正在干）' : ''}
          </p>
        )}
        {delegated.lastError !== '' && <p className="sense-error">{delegated.lastError}</p>}
        {delegateNotice !== '' && <p className="muted">{delegateNotice}</p>}
        {delegated.history.length > 0 && (
          <>
            <h3>最近派的活</h3>
            <ul className="plain-list" data-testid="delegate-history">
              {delegated.history.map((item) => (
                <li key={`${item.at}-${item.target}`}>
                  <span>
                    {item.target}
                    {item.project !== '' ? ` · ${item.project}` : ''}：{item.task}
                  </span>
                  <small className={`outcome-${item.outcome === 'ok' ? 'allowed' : 'denied'}`}>
                    {formatClock(item.at)} · {delegateOutcomeLabels[item.outcome]} ·{' '}
                    {Math.max(1, Math.round(item.ms / 1_000))} 秒
                    {item.code !== null && item.code !== 0 ? ` · 退出码 ${item.code}` : ''}
                    {item.error !== '' ? ` · ${item.error}` : ''}
                  </small>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <FilesCard />
      <McpCard />
      <FaceCard />
      <section className="card" data-testid="ai-stt">
        <div className="section-heading">
          <h2>听懂你说话</h2>
          <span className="label">
            {stt.status === 'ready' ? stt.model : stt.status === 'no-key' ? '缺 Key' : '没开'}
          </span>
        </div>
        {/*
          这段话必须说清两件和上面不同的事：这里会真的录音，而且音频会离开这台电脑。
          含糊成「语音输入」会让人以为还只是算音量。
        */}
        <p className="muted">
          和上面的「耳朵」不是一回事：耳朵只算音量，这一项会真录音，并把那一段音频上传到
          硅基流动转成文字。只在按住小屏上的「◉ 按住说」时才录，松手就停、转完即丢，
          不存盘也不进聊天记录。转出来的字会先填进输入框，确认后再发。
        </p>
        <label className="switch-row">
          <input
            type="checkbox"
            aria-label="听懂我说话"
            checked={sttEnabled}
            onChange={(event) => void toggleStt(event.target.checked)}
          />
          听懂我说话（按住录音转文字）
        </label>
        <form className="stt-key" onSubmit={(event) => void saveSttKey(event)}>
          <input
            type="password"
            aria-label="硅基流动 API Key"
            value={sttKey}
            autoComplete="off"
            placeholder={stt.status === 'no-key' ? '粘贴硅基流动的 Key' : '已保存，要换就粘贴新的'}
            onChange={(event) => {
              setSttKey(event.target.value);
              setSttNotice('');
            }}
          />
          <button type="submit" disabled={sttKey.trim() === ''}>
            保存 Key
          </button>
          {stt.status !== 'off' && (
            <button type="button" onClick={() => void clearSttKey()}>
              清除
            </button>
          )}
        </form>
        <p className="muted">
          免费额度来自硅基流动的 SenseVoiceSmall，一个 Key 够日常用；限流时它会说「等一分钟」。
        </p>
        <div className="stt-last" data-testid="stt-last">
          {stt.lastText !== '' ? (
            <>
              <b>上次转出</b>
              <span>{stt.lastText}</span>
            </>
          ) : (
            <span className="muted">还没转过。填好 Key 后，去小屏按住麦克风说一句。</span>
          )}
        </div>
        {stt.lastError !== '' && <p className="sense-error">{stt.lastError}</p>}
        {sttNotice !== '' && <p className="muted">{sttNotice}</p>}
      </section>
      <section
        className={`card${drop.dragging ? ' dropping' : ''}`}
        data-testid="ai-chat"
        {...drop.handlers}
      >
        <h2>和伙伴说句话</h2>
        <p className="muted">
          回复会同时出现在这里和你桌面上的伙伴小屏。需要实时信息时它会自己去查，
          答话里只说结果、不塞链接——查到的东西统一列在下面，想核对再点。
          未配置或请求失败时，桌面伙伴的台词仍是本地预设，不会把预设台词伪装成 AI 回复。
        </p>
        <div className="ai-log" role="log" data-testid="ai-log">
          {messages.length === 0 && !partial ? (
            <p className="empty-state">还没有对话。先保存凭据，再发一句试试。</p>
          ) : (
            messages.map((message, index) => (
              <div className={`ai-bubble ${message.role}`} key={`${index}-${message.role}`}>
                <small>{message.role === 'user' ? '你' : 'DeepSeek · 芯伴'}</small>
                <span>{message.content}</span>
              </div>
            ))
          )}
          {partial !== '' && (
            <div className="ai-bubble assistant streaming" data-testid="ai-streaming">
              <small>DeepSeek · 芯伴 · 正在回复</small>
              <span>{partial}</span>
            </div>
          )}
        </div>
        {trace.length > 0 && (
          <div className="ai-trace" data-testid="ai-trace">
            <h3>本次工具</h3>
            <ol>
              {trace.map((item) => (
                <li
                  key={item.callId}
                  className={`trace-${item.status}`}
                  data-testid={`trace-${item.name}`}
                >
                  <span className="trace-label">{item.label}</span>
                  <span className="trace-note">
                    {item.status === 'running'
                      ? '进行中…'
                      : item.status === 'error'
                        ? item.note
                        : item.note}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
        {citations.length > 0 && (
          <div className="ai-sources" data-testid="ai-citations">
            <h3>来源</h3>
            <ul>
              {citations.map((item, index) => (
                <li key={`${item.url}-${index}`}>
                  <button
                    type="button"
                    className="link-button"
                    title={item.url}
                    onClick={() => void openLink(item.url)}
                  >
                    {item.title || item.url}
                  </button>
                  <small>{item.site}</small>
                </li>
              ))}
            </ul>
          </div>
        )}
        {session.job && <JobStatus job={session.job} />}
        {attached.length > 0 && (
          <ul className="attach-list" data-testid="ai-attachments">
            {attached.map((item) => (
              <li key={item.id}>
                <span title={item.rel}>
                  {item.kind === 'image' ? '🖼' : '📄'} {item.name}
                </span>
                <small className="muted">{sizeText(item.size)}</small>
                <button
                  type="button"
                  aria-label={`移除附件 ${item.name}`}
                  onClick={() =>
                    setAttached((current) => current.filter((other) => other.id !== item.id))
                  }
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className="input-row" onSubmit={(event) => void send(event)}>
          <button
            type="button"
            aria-label="附上文件"
            title="附上文件（也可以直接拖进来）"
            disabled={busy}
            onClick={() =>
              void window.companion!.attachPick().then((result) => {
                if (result.ok) {
                  setAttached((current) =>
                    [...current, ...result.items].slice(-attachmentLimits.maxFiles),
                  );
                } else if (result.error !== '') setError(result.error);
              })
            }
          >
            📎
          </button>
          <input
            aria-label="给伙伴的消息"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={aiDefaults.maxInputChars}
            placeholder="想说点什么…"
            disabled={busy}
          />
          <button
            className="primary"
            type="submit"
            disabled={busy || (!draft.trim() && attached.length === 0) || !status?.configured}
          >
            {busy ? '回复中…' : '发送'}
          </button>
          {busy && (
            <button type="button" onClick={() => void cancel()}>
              取消
            </button>
          )}
        </form>
        {failure && (
          <div className="error-banner" role="alert">
            {failure}
          </div>
        )}
        {notice && <p role="status">{notice}</p>}
      </section>
      <section className="card" data-testid="ai-work">
        <div className="section-heading">
          <h2>你在忙什么</h2>
          <span className="label">
            {work.error !== '' ? '看不到' : `${work.sessions.length} 个会话`}
          </span>
        </div>
        <p className="muted">
          这一栏来自本机 WorkBuddy 的会话记录（<code>~/.workbuddy/projects</code>）， 只读、只数最近
          6 小时，不外传。芯伴说话时会带着这份上下文，你问「我那个弄到哪了」它照实答。
        </p>
        {work.error !== '' ? (
          <p className="empty-state">读不到：{work.error}。没有 WorkBuddy 会话时这一栏是空的。</p>
        ) : work.sessions.length === 0 ? (
          <p className="empty-state">最近没看到你在别处干活。</p>
        ) : (
          <ul className="work-list">
            {work.sessions.map((session) => (
              <li key={session.sessionId} data-testid="work-session">
                <div className="work-title">
                  <strong>{session.title}</strong>
                  <span className={`work-badge work-${session.status}`}>
                    {session.status === 'working'
                      ? shortActivity(session)
                      : session.status === 'resting'
                        ? '刚停手'
                        : '搁着'}
                  </span>
                </div>
                <small>
                  {timeAgo(session.updatedAt, Date.now())} · 最近完成 {session.stepCount} 步
                </small>
                {session.lastUserText !== '' && (
                  <p className="work-ask">他提的：{session.lastUserText}</p>
                )}
                {session.steps.length > 0 && (
                  <p className="work-steps">
                    {session.steps.map((step) => step.label).join(' → ')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="button-row">
          <button
            type="button"
            onClick={() => {
              void window.companion!.workRefresh();
            }}
          >
            重新读一次
          </button>
        </div>
      </section>
      <section className="card" data-testid="ai-memory">
        <div className="section-heading">
          <h2>它记得你</h2>
          <span className="label">{memory.enabled ? `${memory.facts.length} 条` : '已关闭'}</span>
        </div>
        <p className="muted">
          长期记忆存放在本机 <code>memory-v1.json</code>，不会随聊天记录一起导出。
          你发消息时，相关的几条会作为背景发给 DeepSeek——不相关的不会上传。
          记错了就删，不想被记就关掉；聊天记录本身仍然只在内存里，退出即清空。
        </p>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={memory.enabled}
            onChange={(event) => void toggleMemory(event.target.checked)}
            aria-label="启用长期记忆"
          />
          允许它记住关于你的事
        </label>
        <MemoryTidy factCount={memory.facts.length} enabled={memory.enabled} />
        {memory.facts.length === 0 ? (
          <p className="empty-state">
            还没记住什么。聊几句，它自己会记；也可以直接对它说「记住…」。
          </p>
        ) : (
          <ul className="memory-list">
            {memory.facts.map((fact) => (
              <li key={fact.id} data-testid="memory-fact">
                <span className="memory-tag">{memoryCategoryLabels[fact.category]}</span>
                <span className="memory-text">{fact.text}</span>
                <button
                  type="button"
                  className="memory-drop"
                  aria-label={`忘记：${fact.text}`}
                  onClick={() => void dropFact(fact.id)}
                >
                  忘记
                </button>
              </li>
            ))}
          </ul>
        )}
        {memory.episodes.length > 0 && (
          <div className="memory-episodes">
            <h3>最近聊过</h3>
            <ul>
              {memory.episodes.slice(0, 3).map((episode) => (
                <li key={episode.id}>{episode.summary}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="button-row">
          {memory.facts.length > 0 &&
            (confirmMemory ? (
              <>
                <button className="danger-text" type="button" onClick={() => void clearMemory()}>
                  确认清空全部记忆
                </button>
                <button type="button" onClick={() => setConfirmMemory(false)}>
                  取消
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setConfirmMemory(true)}>
                清空全部记忆
              </button>
            ))}
        </div>
      </section>
    </>
  );
}
