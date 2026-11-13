import { useEffect, useRef, useState } from 'react';
import type { Action, AppState } from '../core/schema';
import type { ButtonId, Gesture } from '../core/input';
import { intentFor } from '../core/gesture';
import { secondsLeft } from '../core/confirm';
import { dueLabel } from '../core/device-view';
import { useConfirm, useMusic, useProactive } from './useLive';
import { musicLine } from '../core/music';
import { displayState, formatClock, formatDuration, remainingMs } from '../core/state';
import { lastExchange, type AiSessionState } from '../core/ai-session';
import { describeSession, shortActivity, type WorkProgressState } from '../core/progress';
import type { WorkbenchState } from '../core/workbench';
import { PetBench } from './PetBench';
import { petExcerpt, storyRequest } from '../core/persona';
import type { SensesConfig, SensesReading } from '../core/senses';
import { useDeviceButtons } from './useDeviceButtons';
import { useRecorder } from './useRecorder';
import { Face } from './Face';
import {
  chatFeeling,
  defaultFacePrefs,
  faceOf,
  feelingMs,
  jobFeeling,
  mouthOpenOf,
  type ChatFeeling,
  type FacePrefs,
} from '../core/expression';

/**
 * full = 控制面板里的 ESP32-S3 概念装配预览；
 * compact = 真正悬浮在桌面的紧凑屏幕宠物。
 * 两种外观共用同一套手势、游戏与状态逻辑，避免桌面与真机语义分叉。
 *
 * AI 对话只出现在 compact：桌宠小屏是「伙伴」，回复应该在小屏上说出来，
 * 而不是只躺在控制面板里。
 */
export type DeviceVariant = 'full' | 'compact';

/** 桌宠屏幕的内容：表情/游戏，或对话。对话优先，避免回复被表情区挡住。 */
export type PetAiMode = 'off' | 'chat';

export function Device({
  state,
  send,
  variant = 'full',
  aiSession,
  aiMode = 'off',
  onAiMode,
  onAiSend,
  onOpenPanel,
  work,
  bench,
  idleLines,
  senses,
  reading,
  speaking = false,
  voiceReady = false,
  onBeforeVoiceStart,
  face = defaultFacePrefs,
}: {
  /** 表情偏好：画风、关掉的表情、跟不跟聊天情绪。 */
  face?: FacePrefs;
  state: AppState;
  send: (action: Action) => Promise<boolean>;
  variant?: DeviceVariant;
  aiSession?: AiSessionState;
  aiMode?: PetAiMode;
  onAiMode?: (mode: PetAiMode) => void;
  onAiSend?: (text: string) => Promise<{ ok: boolean; error?: string }>;
  /** 小屏放不下的长回复，从这里去面板看全文。 */
  onOpenPanel?: () => void;
  /** 用户在别处（WorkBuddy）的工作进度；只在小屏空着的时候占一行。 */
  work?: WorkProgressState;
  /** 工作台：屏脚显示「2 个等你 · 1 个待看」，桌宠上点一下就在屏上展开。 */
  bench?: WorkbenchState;
  /** 用户自己写的闲时标语；不传就用内置那句。 */
  idleLines?: readonly string[];
  /** 耳朵眼睛的开关：决定屏幕上要不要说「在听/在看」，这是隐私提示，不是装饰。 */
  senses?: SensesConfig;
  /** 最近一次采集读数：音量驱动嘴型，有没有人驱动眼神。 */
  reading?: SensesReading;
  /** 正在念回复。小屏要说出来，否则用户分不清「没配声音」和「念完了」。 */
  speaking?: boolean;
  /** 语音转写配好了没：没配就不显示麦克风按钮，免得按下去只换回一句「没配好」。 */
  voiceReady?: boolean;
  /** 按下麦克风之前要做的事：正在念的回复得停掉，否则会被自己录进去。 */
  onBeforeVoiceStart?: () => void;
}) {
  const display = displayState(state, { idleLines });
  /**
   * 刚聊完一句或派的活刚交回来：脸上挂几秒对应的情绪。
   * 只在「新的一轮」出现时触发；窗口刚打开时已有的对话不算。
   */
  const [felt, setFelt] = useState<{ kind: ChatFeeling; at: number } | null>(null);
  const feeling = felt?.kind ?? null;
  useEffect(() => {
    if (felt === null) return;
    const timer = setTimeout(() => setFelt(null), feelingMs);
    return () => clearTimeout(timer);
  }, [felt]);
  // 会话最多留 40 轮，条数会到顶不再涨：用「最后一条是什么」判断有没有新的一轮。
  const seenTurn = useRef<string | null>(null);
  const lastTurn = aiSession?.turns[aiSession.turns.length - 1];
  const turnKey = lastTurn ? `${aiSession?.turns.length}:${lastTurn.role}:${lastTurn.content}` : '';
  useEffect(() => {
    if (!aiSession || aiSession.busy) return;
    const first = seenTurn.current === null;
    const changed = !first && turnKey !== seenTurn.current;
    seenTurn.current = turnKey;
    if (!changed || lastTurn?.role !== 'assistant') return;
    let next: ChatFeeling | null;
    if (lastTurn.external !== undefined) next = jobFeeling(lastTurn.content);
    else if (!face.followChat) next = null;
    else {
      const exchange = lastExchange(aiSession);
      next = exchange ? chatFeeling(exchange.question, exchange.answer) : null;
    }
    if (next !== null) setFelt({ kind: next, at: Date.now() });
    // 只在「有新的一轮」或忙闲切换时重算，其余字段变化不该重新触发情绪。
  }, [turnKey, aiSession?.busy]);
  const clock = formatClock(state.now);
  // 确认与主动提醒由主进程持有，桌宠与面板预览看到的是同一张卡。
  const confirm = useConfirm();
  const proactive = useProactive();
  const music = useMusic();
  const pendingConfirm = confirm.pending;
  const nudge = proactive.current;
  const card = pendingConfirm !== null || nudge !== null;
  // 摸摸的反应来自关系账本：越熟话越随便，猛摸会烦。
  const petText =
    proactive.petLine !== null && proactive.petLine.until > state.now ? proactive.petLine.text : '';
  const title =
    display.mood === 'happy' && state.petUntil > state.now && petText ? petText : display.title;
  const [game, setGame] = useState<'off' | 'wait' | 'go' | 'result'>('off');
  const [result, setResult] = useState('');
  const [feedback, setFeedback] = useState('');
  const start = useRef(0);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const interrupted =
    card ||
    ['waiting', 'sad'].includes(display.mood) ||
    state.timer?.status === 'completed' ||
    !state.simulation.connected;
  useEffect(() => {
    if (interrupted) {
      clearTimeout(timeout.current);
      setGame('off');
    }
    return () => clearTimeout(timeout.current);
  }, [interrupted]);
  useEffect(() => () => clearTimeout(feedbackTimer.current), []);
  function note(text: string) {
    clearTimeout(feedbackTimer.current);
    setFeedback(text);
    feedbackTimer.current = setTimeout(() => setFeedback(''), 2_400);
  }
  function interact() {
    if (game === 'wait') {
      clearTimeout(timeout.current);
      setResult('太快啦，再试一次');
      setGame('result');
    } else if (game === 'go') {
      setResult(`${Math.round(performance.now() - start.current)} ms · 反应时间`);
      setGame('result');
    } else {
      void send({ type: 'pet.interact' });
    }
  }
  function play() {
    clearTimeout(timeout.current);
    if (game !== 'off') {
      setGame('off');
      return;
    }
    if (interrupted) {
      note('有需要处理的提示，先不开始游戏');
      return;
    }
    setGame('wait');
    timeout.current = setTimeout(
      () => {
        start.current = performance.now();
        setGame('go');
      },
      1500 + Math.random() * 2000,
    );
  }
  /**
   * 手势 → 意图走 core/gesture 的同一张表，实体按键在主进程里也是它。
   * 这里只多处理桌面独有的事：反应游戏和小字反馈。
   */
  function onGesture(button: ButtonId, gesture: Gesture) {
    const waiting = state.simulation.tasks.find((item) => item.status === 'waiting');
    const intent = intentFor(
      {
        confirmId: pendingConfirm?.id ?? null,
        nudgeId: nudge?.id ?? null,
        // 游戏进行中 A 是游戏键，不去确认模拟任务。
        waitingTaskId: game === 'off' ? (waiting?.id ?? null) : null,
        timerRecovery: game === 'off' && state.timer?.status === 'recovery',
      },
      button,
      gesture,
    );
    switch (intent.type) {
      case 'confirm-answer':
        void window.companion?.confirmAnswer(intent.id, intent.allow);
        note(intent.allow ? '好，去做了' : '不做了');
        break;
      case 'nudge-answer':
        void window.companion?.proactiveAnswer(intent.id, intent.accept ? 'accept' : 'dismiss');
        if (intent.accept && nudge?.askPrompt) onAiMode?.('chat');
        break;
      case 'sim-ack':
        void send({ type: 'sim.acknowledge', taskId: intent.taskId });
        note('已确认，继续陪你做下去');
        break;
      case 'timer-recovery-hint':
        note('计时被打断了：点屏幕下方的计时就能继续');
        break;
      case 'interact':
        interact();
        break;
      case 'game-toggle':
        play();
        break;
      case 'quiet-toggle':
        void send({ type: 'settings.patch', patch: { quiet: !state.settings.quiet } });
        note(state.settings.quiet ? '已关闭勿扰' : '已开启勿扰 · 长按 B');
        break;
      case 'unassigned':
        note(`${button} 长按暂未分配动作，且不会补发短按`);
        break;
    }
  }
  const { bind, pressing } = useDeviceButtons(onGesture);
  const moodClass = `mood-${display.mood} ${state.settings.reducedMotion ? 'reduced' : ''}`;

  // 感官的派生状态。只认「通道真的拿到了流」：开关打开但还停在 starting 时
  // 不能显示「在听」——那是在替设备撒谎，用户会以为麦克风已经开了。
  const earsLive = senses?.ears === true && reading?.mic === 'live';
  const eyesLive = senses?.eyes === true && reading?.camera === 'live';
  const listening = earsLive && reading?.speaking === true;
  // 人走开：摄像头开着、读数新鲜、且确实有一阵没动静。
  const away = eyesLive && reading?.present === false;
  const senseLabel =
    earsLive && eyesLive ? '在听 · 在看' : earsLive ? '在听' : eyesLive ? '在看' : '';
  // 「在说」和「在听」可以同时成立（它念的时候你插一句），所以并排显示而不是互相覆盖。
  const topLabel = [senseLabel, speaking ? '在说' : ''].filter((item) => item !== '').join(' · ');
  const senseTitle = [
    senses?.ears
      ? earsLive
        ? listening
          ? '麦克风开着：听见你在说话（只算音量，不录音、不转文字）'
          : '麦克风开着：此刻没有声音（只算音量，不录音、不转文字）'
        : '麦克风开关是开的，但还没拿到设备'
      : '麦克风没开',
    senses?.eyes
      ? eyesLive
        ? away
          ? '摄像头开着：有一阵子没看到人动'
          : '摄像头开着：画面里有人（只看有没有动静，不保存画面）'
        : '摄像头开关是开的，但还没拿到画面'
      : '摄像头没开',
  ].join(' · ');
  // 嘴型跟着音量走：只有一个 0~1 的包络，没有波形，也没有可回放的东西。
  // 它在念回复时没有包络可用（音频在 <audio> 里），给一个固定基准由动画去做开合。
  const mouthOpen = mouthOpenOf({ listening, speaking, level: reading?.level ?? 0 });
  const expression = faceOf(
    {
      mood: display.mood,
      thinking: aiSession?.busy === true,
      speaking,
      listening,
      away: away === true,
      playing: game !== 'off' && !interrupted,
      working: aiSession?.job != null,
      feeling,
    },
    face.off,
  );

  const exchange = aiSession ? lastExchange(aiSession) : null;
  // 小屏只放得下一条短回复。提示词已经要求简短，这里再兜一层：
  // 超长就截断并给一个「全文」入口，而不是把整段塞进 216px 里让谁都不想读。
  const excerpt = exchange ? petExcerpt(exchange.answer) : null;
  const lastTrace = aiSession?.trace[aiSession.trace.length - 1];
  const showAi = variant === 'compact' && aiMode !== 'off';
  // 工作台在屏上展开：只在桌宠里；对话开着时让对话。
  const [benchOpen, setBenchOpen] = useState(false);
  const showBench = variant === 'compact' && benchOpen && !showAi && bench !== undefined;
  // 只挑「正在干活」的那条：刚停手的会话不占小屏，避免屏幕上永远挂着一行旧的。
  // 在等你确认的优先：那是唯一需要你立刻动手的（来自官方钩子）。
  const liveWork =
    work?.sessions.find((session) => session.signal === 'waiting') ??
    work?.sessions.find((session) => session.status === 'working');
  // 要你管的（等你/出错/干完没看）不止一件，或那一件不是正在等你的会话：换成工作台摘要。
  const attention = bench ? bench.counts.waiting + bench.counts.error + bench.counts.unseen : 0;
  const benchLine =
    bench && attention > 0 && (attention > 1 || liveWork?.signal !== 'waiting')
      ? bench.summary
      : '';
  const workLine =
    benchLine || (liveWork ? `${liveWork.project} · ${shortActivity(liveWork)}` : '');
  const workSource = liveWork?.source ?? 'WorkBuddy';
  // 待办是用户自己写的清单，比推断出来的任何状态都该看得见。
  // 只取列表最上面那件没做完的，其余用 +N 交代，不把 216px 变成清单页。
  const openTodos = state.todos.filter((todo) => !todo.done);
  // 有到期时间的排前面：屏上只放一件，就放最急的那件（与实体屏同一规则）。
  const nextTodo = [...openTodos].sort(
    (a, b) => (a.dueAt ?? Number.POSITIVE_INFINITY) - (b.dueAt ?? Number.POSITIVE_INFINITY),
  )[0];
  // 小屏只有 216px 高：屏脚挤进去就得挪走别的东西。
  // 让出的是底部那句装饰文案（「不用着急／我在这里」）；有计时表时它更重要，屏脚让路。
  const showTodo = nextTodo !== undefined && state.timer === null;
  const showWork = workLine !== '' && state.timer === null;
  // 音乐只在没有待办和工作进度时占屏脚：它是陪伴，不该挤掉正事。
  const song = music?.nowPlaying?.status === 'playing' ? musicLine(music.nowPlaying) : '';
  const showMusic = song !== '' && !showTodo && !showWork && state.timer === null;
  const showFoot = showTodo || showWork || showMusic;
  const todoHint = `点一下划掉 · 还有 ${openTodos.length} 件没做完`;
  const [draft, setDraft] = useState('');
  /**
   * 按住说话。
   *
   * 转出来的字**填进草稿而不是直接发送**：语音转写会有同音错字，
   * 尤其人名和专有名词。让人先看一眼再发，比事后纠正便宜得多。
   */
  const voice = useRecorder({
    ready: voiceReady,
    onText: (text) => setDraft((current) => (current.trim() === '' ? text : `${current} ${text}`)),
    onError: (message) => note(message),
    onBeforeStart: onBeforeVoiceStart,
  });
  const threadRef = useRef<HTMLDivElement | null>(null);
  // 回复或提问变长时把对话滚到底部，用户不用在小屏里手动拖。
  useEffect(() => {
    const node = threadRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [excerpt?.text, aiMode]);

  function submitAi() {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    onAiMode?.('chat');
    void onAiSend?.(text);
  }

  const petAiContent = showAi ? (
    <>
      {/*
       * 脸在对话模式里也要在。之前一进对话就把整块屏换成线程，
       * 结果表情系统十种脸谱全做了、用户聊天时一张都看不见——
       * 「表情多样化没做」的体感就是这么来的：不是没画，是画了不给看。
       */}
      <div className="ai-face" data-testid="pet-ai-face">
        <Face spec={expression} open={mouthOpen} talking={speaking} variant={face.style} />
      </div>
      <div className="ai-thread" data-testid="pet-ai-thread" ref={threadRef}>
        {exchange ? (
          <>
            <p className="ai-question">{exchange.question}</p>
            <p className="ai-answer" data-testid="pet-ai-answer">
              {excerpt?.text || '…'}
            </p>
            {excerpt?.truncated && (
              <button type="button" className="ai-more" onClick={() => onOpenPanel?.()}>
                全文 ↗
              </button>
            )}
          </>
        ) : (
          <p className="ai-empty">按住 ◉ 说一句，或直接打字。问完接着问，不用再点开关。</p>
        )}
        {aiSession?.busy && (
          <small className="ai-busy" data-testid="pet-ai-tool">
            {lastTrace
              ? `${lastTrace.label}${lastTrace.status === 'running' ? '…' : ` · ${lastTrace.note}`}`
              : '正在回复…'}
          </small>
        )}
        {aiSession?.error && (
          <p className="ai-error" role="alert">
            {aiSession.error}
          </p>
        )}
      </div>
      {/*
       * 输入行常驻在对话下面，而不是「输入」和「记录」两个互斥视图。
       * 之前发完一句就切到记录视图，想再问必须点两次（收起 → 说话）；
       * 多轮对话本来就是连着说的，让用户为每一轮付两次点击是设计错误。
       */}
      <form
        className="ai-compose-bar"
        onSubmit={(event) => {
          event.preventDefault();
          submitAi();
        }}
      >
        <input
          aria-label="给伙伴的消息"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={2000}
          placeholder="说点什么…"
          autoFocus
        />
        {voiceReady && (
          // 按住说话。松手（或指针移出）就结束——没有「点一下开始、再点一下停」，
          // 那种交互很容易忘记停，录出一段没人要的东西。
          <button
            type="button"
            className={`ai-mic ${voice.recording ? 'hot' : ''}`}
            data-testid="pet-mic"
            aria-label={voice.recording ? '松开结束' : '按住说话'}
            title={voice.recording ? '松开就转成文字' : '按住说话，松开转成文字'}
            onPointerDown={(event) => {
              event.preventDefault();
              void voice.start();
            }}
            onPointerUp={() => voice.stop()}
            onPointerLeave={() => voice.stop()}
            onPointerCancel={() => voice.stop()}
          >
            {voice.recording ? (
              <>
                <i className="mic-dot" />
                {Math.floor(voice.elapsedMs / 1000)}s
              </>
            ) : (
              '◉'
            )}
          </button>
        )}
        <button
          type="button"
          className="ai-story"
          data-testid="pet-story"
          aria-label="讲个故事"
          title="讲个故事（输入框里写了主题就讲那个）"
          disabled={aiSession?.busy === true}
          onClick={() => {
            const theme = draft;
            setDraft('');
            onAiMode?.('chat');
            void onAiSend?.(storyRequest(theme));
          }}
        >
          ✦
        </button>
        <button className="ai-send" type="submit" disabled={!draft.trim()}>
          发送
        </button>
      </form>
    </>
  ) : null;

  /**
   * 屏上的卡：确认优先于提醒。对话模式里也盖在最上面——它在等你点头时，
   * 其余内容都该让路。卡上的两个按钮和实体 A/B 是同一件事。
   */
  const cardNode = pendingConfirm ? (
    <div className="screen-card confirm" role="alertdialog" data-testid="pet-confirm">
      <strong>{pendingConfirm.title}</strong>
      <code>{pendingConfirm.detail}</code>
      <div className="card-actions">
        <button
          type="button"
          onClick={() => void window.companion?.confirmAnswer(pendingConfirm.id, true)}
        >
          A 允许
        </button>
        <button
          type="button"
          onClick={() => void window.companion?.confirmAnswer(pendingConfirm.id, false)}
        >
          B 拒绝
        </button>
        <small>{secondsLeft(pendingConfirm, state.now)}s</small>
      </div>
    </div>
  ) : nudge ? (
    <div className={`screen-card nudge mood-${nudge.mood}`} role="status" data-testid="pet-nudge">
      <strong>{nudge.text}</strong>
      <div className="card-actions">
        <button
          type="button"
          onClick={() => {
            void window.companion?.proactiveAnswer(nudge.id, 'accept');
            if (nudge.askPrompt) onAiMode?.('chat');
          }}
        >
          A {nudge.askPrompt ? '细说' : '好'}
        </button>
        <button
          type="button"
          onClick={() => void window.companion?.proactiveAnswer(nudge.id, 'dismiss')}
        >
          B 知道了
        </button>
      </div>
    </div>
  ) : null;

  const screen = (
    <div className="device-screen" aria-label="桌面伙伴的小屏">
      {cardNode}
      <div className="screen-top">
        <span title={senseTitle}>
          <i className={`status-dot ${listening ? 'hot' : ''}`} />
          {showAi
            ? '芯伴对话'
            : showBench
              ? `工作台${bench?.summary ? ` · ${bench.summary}` : ''}`
              : topLabel || (display.simulated ? '模拟事件' : '本地伙伴')}
        </span>
        {showAi ? (
          <button
            className="ai-close"
            type="button"
            onClick={() => onAiMode?.('off')}
            aria-label="收起对话"
          >
            ✕
          </button>
        ) : (
          // 右下角原来写的是「DEMO」——一块真机上也会显示的屏，占着位置说自己是假的。
          // 换成时间：小屏挂在桌面上，用户扫一眼就知道现在几点。
          // 点一下就切勿扰：不用记「长按 B 800ms」，也不用去面板。
          <button
            type="button"
            className={`screen-clock ${state.settings.quiet ? 'quiet' : ''}`}
            data-testid="screen-quiet"
            aria-pressed={state.settings.quiet}
            title={state.settings.quiet ? '勿扰中 · 点一下关掉' : '点一下开启勿扰'}
            onClick={async () => {
              const quiet = !state.settings.quiet;
              const ok = await send({ type: 'settings.patch', patch: { quiet } });
              note(
                ok ? (quiet ? '已开启勿扰 · 再点一下关掉' : '已关闭勿扰') : '没切换成，稍后再试',
              );
            }}
          >
            {state.settings.quiet ? '勿扰 ✕' : clock}
          </button>
        )}
      </div>
      {showAi ? (
        petAiContent
      ) : showBench && bench ? (
        <PetBench
          bench={bench}
          onClose={() => setBenchOpen(false)}
          onNote={note}
          onOpenPanel={onOpenPanel}
          onFollowUp={(prefix) => {
            setBenchOpen(false);
            setDraft(prefix);
            onAiMode?.('chat');
          }}
        />
      ) : game !== 'off' && !interrupted ? (
        <div className="game-screen" aria-live="polite">
          <span className="game-symbol">{game === 'go' ? '●' : game === 'wait' ? '○' : '✦'}</span>
          <strong>{game === 'go' ? '现在按 A！' : game === 'wait' ? '等圆点亮起…' : result}</strong>
          <small>B 键退出 · 不保存成绩</small>
        </div>
      ) : (
        <div className="screen-body">
          <Face spec={expression} open={mouthOpen} talking={speaking} variant={face.style} />
          <strong className="screen-title" data-testid="screen-title">
            {title}
          </strong>
          <div className="screen-detail" data-testid="screen-detail" title={display.detail}>
            {display.detail}
          </div>
          {showFoot ? (
            <div className="screen-foot">
              {showTodo && nextTodo !== undefined && (
                // 一张卡片，不是一行小字：待办是这块屏上唯一能动手的东西，
                // 在桌宠上点一下就能划掉，划错了回面板还能取消勾选。
                <button
                  type="button"
                  className="todo-card"
                  data-testid="screen-todo"
                  title={todoHint}
                  onClick={async () => {
                    // 写盘失败时别谎报「做完了」：这条待办还挂在屏幕上，
                    // 用户需要知道它没被划掉，而不是等下次打开才发现。
                    const ok = await send({ type: 'todo.toggle', id: nextTodo.id });
                    note(
                      ok
                        ? openTodos.length > 1
                          ? '划掉一件，接着来'
                          : '这件做完了 ✦'
                        : '没划掉，稍后再试',
                    );
                  }}
                >
                  <span className="todo-check" aria-hidden="true" />
                  <span className="todo-text">{nextTodo.title}</span>
                  {typeof nextTodo.dueAt === 'number' && (
                    <span className="todo-when">{dueLabel(nextTodo.dueAt, state.now)}</span>
                  )}
                  {openTodos.length > 1 && (
                    <span className="todo-more">+{openTodos.length - 1}</span>
                  )}
                </button>
              )}
              {showWork && (
                <button
                  type="button"
                  className="work-line work-button"
                  data-testid="screen-work"
                  disabled={variant !== 'compact' || bench === undefined}
                  onClick={() => setBenchOpen(true)}
                  title={
                    benchLine || liveWork === undefined
                      ? '点一下在屏上看是谁、结果是什么'
                      : `${describeSession(liveWork, state.now)} · 点一下看工作台`
                  }
                >
                  <i className="work-pulse" />
                  {/* 和待办卡片同时出现时省掉 WorkBuddy 前缀：项目名比它更该被看见，
                      否则只能截成「WorkBuddy ai-desktop-companion · 正在…」。 */}
                  <span className="work-text">
                    {showTodo || benchLine ? workLine : `${workSource} ${workLine}`}
                  </span>
                  {variant === 'compact' && <span className="work-more">›</span>}
                </button>
              )}
              {showMusic && (
                <button
                  type="button"
                  className="work-line music-line"
                  data-testid="screen-music"
                  title={`${music?.nowPlaying?.appLabel ?? ''} · 点一下暂停`}
                  onClick={() => void window.companion?.musicControl('toggle')}
                >
                  <span className="work-text">{song}</span>
                </button>
              )}
            </div>
          ) : state.timer ? (
            // 计时在屏上就能管：点一下暂停/继续，到点了点一下收下；停着时可以 ✕ 结束。
            <div className="screen-bottom">
              <button
                type="button"
                className="timer-button"
                data-testid="screen-timer"
                title={
                  state.timer.status === 'running'
                    ? '点一下暂停'
                    : state.timer.status === 'completed'
                      ? '点一下收下'
                      : '点一下继续'
                }
                onClick={async () => {
                  const status = state.timer?.status;
                  const action =
                    status === 'running'
                      ? ({ type: 'timer.pause' } as const)
                      : status === 'completed'
                        ? ({ type: 'timer.cancel' } as const)
                        : ({ type: 'timer.resume' } as const);
                  const ok = await send(action);
                  note(
                    !ok
                      ? '没切换成，稍后再试'
                      : status === 'running'
                        ? '暂停了 · 再点一下继续'
                        : status === 'completed'
                          ? '收下了，歇一会儿'
                          : '接着专注',
                  );
                }}
              >
                <span>
                  {state.timer.status === 'paused'
                    ? '已暂停 ▸'
                    : state.timer.status === 'recovery'
                      ? '待恢复 ▸'
                      : state.timer.status === 'completed'
                        ? '时间到 · 收下'
                        : '专注中 ‖'}
                </span>
                <b>{formatDuration(remainingMs(state.timer, state.now))}</b>
              </button>
              {(state.timer.status === 'paused' || state.timer.status === 'recovery') && (
                <button
                  type="button"
                  className="timer-end"
                  data-testid="screen-timer-end"
                  aria-label="结束专注"
                  title="结束这段专注"
                  onClick={async () => {
                    const ok = await send({ type: 'timer.cancel' });
                    note(ok ? '这段专注结束了' : '没结束成，稍后再试');
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );

  const buttonA = (
    <button
      className={`physical-button ${pressing === 'A' ? 'pressing' : ''}`}
      {...bind('A')}
      aria-label="A 互动按钮"
      title="短按：互动／游戏确认 · 长按：暂未分配"
    >
      A
    </button>
  );
  const buttonB = (
    <button
      className={`physical-button secondary ${pressing === 'B' ? 'pressing' : ''}`}
      {...bind('B')}
      aria-label="B 游戏按钮"
      title="短按：开始／退出反应游戏 · 长按 800ms：切换勿扰"
    >
      B
    </button>
  );
  const feedbackNode = feedback ? (
    <p className="input-feedback" role="status" data-testid="input-feedback">
      {feedback}
    </p>
  ) : null;

  if (variant === 'compact') {
    return (
      <div className={`device pet-compact ${moodClass}`} data-testid="device">
        <div className="display-unit" data-pet-interactive>
          {screen}
        </div>
        <div className="device-buttons" data-pet-interactive>
          {buttonA}
          <span className="compact-button-label">A 互动 · B 游戏</span>
          {buttonB}
        </div>
        {feedbackNode}
      </div>
    );
  }

  return (
    <div className={`device ${moodClass}`} data-testid="device">
      <div className="assembly-tag">
        概念装配 <span>非精确板卡复刻</span>
      </div>
      <div className="board" aria-label="ESP32-S3-DevKitC-1 概念开发板，比例与引脚尚未核验">
        <div className="pins pins-left" aria-hidden="true" />
        <div className="pins pins-right" aria-hidden="true" />
        <div className="module">
          <span>ESP32-S3</span>
          <small>DevKitC-1 · 参考基准</small>
        </div>
        <div className="board-label">USB 供电 · 无电池</div>
        <div className="usb" aria-hidden="true" />
      </div>
      <div className="display-unit">
        <span className="screw tl" />
        <span className="screw tr" />
        <span className="screw bl" />
        <span className="screw br" />
        {screen}
        <div className="screen-caption">外接屏幕 · 240 × 240 逻辑画布</div>
      </div>
      <div className="device-buttons">
        {buttonA}
        <span>
          扩展业务按钮
          <br />非 BOOT / RESET
        </span>
        {buttonB}
      </div>
      {feedbackNode}
      <div className="device-stand" aria-hidden="true" />
    </div>
  );
}
