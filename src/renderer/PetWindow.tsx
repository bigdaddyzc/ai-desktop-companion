import { useEffect, useRef, useState } from 'react';
import type { Action, AppState } from '../core/schema';
import { Device, type PetAiMode } from './Device';
import { JobStatus } from './JobStatus';
import { useAiSession } from './useAiSession';
import { useWorkProgress } from './useWorkProgress';
import { useWorkbench } from './useWorkbench';
import { usePersona } from './usePersona';
import { useSensesSnapshot } from './useSensesState';
import { useSenses } from './useSenses';
import { useCameraShot } from './useCameraShot';
import { useVoicePlayer } from './useVoice';
import { useVoiceConfig } from './useVoiceConfig';
import { useSttSnapshot } from './useStt';
import { useProactive } from './useLive';
import { useFileDrop } from './useFileDrop';

/**
 * 桌面宠物窗口。
 *
 * 与旧实现的关键差别：AI 回复不再只躺在控制面板里。
 * 对话状态由主进程广播到这个窗口，伙伴会在自己的小屏上把话说完，
 * 也可以直接在这里输入——控制面板仍然负责配置 Key 和查看完整历史。
 *
 * 采集也在这里：它是唯一常驻可见、也唯一被授权拿摄像头/麦克风的窗口。
 */
export function PetWindow({
  state,
  send,
  problem,
  onWindowAction,
}: {
  state: AppState;
  send: (action: Action) => Promise<boolean>;
  problem: string | null;
  onWindowAction: (action: 'panel' | 'companion' | 'hide' | 'quit') => Promise<void>;
}) {
  const ai = useAiSession();
  const work = useWorkProgress();
  const bench = useWorkbench();
  // 屏幕闲时那句标语由面板配置，桌宠只读。
  const persona = usePersona();
  // 开关在主进程，采在这里；面板读的是同一份上报结果。
  const senses = useSensesSnapshot();
  const reading = useSenses(senses.config);
  // 视觉取帧：主进程要一张摄像头画面时拍一张回传（拍完立刻关设备）。
  useCameraShot();
  // 嗓子由面板配：换完下一句就用新的，不需要重启。
  const voiceConfig = useVoiceConfig();
  // 勿扰时不出声：用户按了「别吵」，包括别念给它听。
  const speech = useVoicePlayer(senses.config.voice && !state.settings.quiet, voiceConfig);
  // 语音转写：只读状态，录音在 Device 里按下才发生。
  const stt = useSttSnapshot();
  const [aiMode, setAiMode] = useState<PetAiMode>('off');
  const [error, setError] = useState('');
  const wasBusy = useRef(false);
  const spoken = useRef('');
  const proactive = useProactive();
  const spokenNudge = useRef<string | null>(null);

  // 主动提醒开口说一句：只在用户允许「念出来」、没在对话中时。
  // 勿扰与语音开关已经由 useVoicePlayer 的 enabled 参数守住，这里不重复。
  const nudge = proactive.current;
  useEffect(() => {
    if (!nudge || nudge.id === spokenNudge.current) return;
    spokenNudge.current = nudge.id;
    if (!proactive.config.speak || ai.busy) return;
    speech.finish(nudge.text);
  }, [nudge, proactive.config.speak, ai.busy, speech.finish]);

  // 新一轮提问开始时自动把屏幕切到对话：在面板里问，桌宠也会开口。
  // 只认「false → true」这一次跳变，用户手动收起后不会因为增量更新被反复弹开。
  useEffect(() => {
    if (ai.busy && !wasBusy.current) setAiMode('chat');
    wasBusy.current = ai.busy;
  }, [ai.busy]);

  // 边生成边念：每来一段增量就把「到目前为止的全文」推过去，内部按句切块并行合成，
  // 第一块一合成完就开口——不用等整段回复写完再合成，这是延迟最大的那一截。
  //
  // 流式缓冲被清空（切到下一步）时不念：中间步的正文是「我先查一下」这类进度话术，
  // 念出来只会把耳朵占满，还压掉真正的结论。
  useEffect(() => {
    if (!ai.busy) return;
    if (ai.streaming === '') {
      speech.stop();
      return;
    }
    speech.push(ai.streaming);
  }, [ai.streaming, ai.busy, speech.push, speech.stop]);

  // 定稿：把尾巴念完。同一段内容不重复念（流式时可能已经念过了）。
  useEffect(() => {
    if (ai.busy) return;
    const last = ai.turns[ai.turns.length - 1];
    if (!last || last.role !== 'assistant') return;
    if (last.content === spoken.current) return;
    spoken.current = last.content;
    speech.finish(last.content);
  }, [ai.turns, ai.busy, speech.finish]);

  // 被打断的判定在**播放期间一律不成立**：扬声器就在麦克风旁边，它在念的时候
  // 「有人说话」这个信号永远为真——一旦当真就立刻把自己掐断，听起来正是
  // 「说了两个字就停」。真正的打断走按住麦克风那条路（`onBeforeVoiceStart`）。
  //
  // 展示上也要跟着屏蔽：不然播放时小屏会显示成「你在说话」，是明摆着的假话。
  const hearing = speech.speaking ? { ...reading, speaking: false } : reading;

  // 把文件拖到伙伴身上：收下就问一句「帮我看看」，要追问再在对话里接着说。
  const drop = useFileDrop(
    (items) => {
      setAiMode('chat');
      void sendAi(
        items.length === 1 ? '帮我看看这个文件。' : '帮我看看这些文件。',
        items.map((item) => item.id),
      );
    },
    (message) => setError(message),
  );

  async function sendAi(text: string, attachments?: string[]) {
    setError('');
    try {
      const result = await window.companion!.aiSend(text, attachments);
      if (!result.ok) setError(result.error);
      return result;
    } catch {
      const failure = { ok: false, error: '消息没有发出去，请检查应用状态。' };
      setError(failure.error);
      return failure;
    }
  }

  return (
    <main className={`pet-window${drop.dragging ? ' pet-dropping' : ''}`} {...drop.handlers}>
      <div className="pet-toolbar" data-pet-interactive>
        <span
          className="drag-handle"
          title="拖动这里移动 · A 短按互动 · B 短按游戏 · B 长按 800ms 切换勿扰"
        >
          ⠿ 芯伴
        </span>
        <button
          className={aiMode === 'off' ? '' : 'active'}
          onClick={() => setAiMode(aiMode === 'off' ? 'chat' : 'off')}
          aria-label={aiMode === 'off' ? '和伙伴说句话' : '结束对话'}
        >
          ✎ {aiMode === 'off' ? '说话' : '收起'}
        </button>
        <button onClick={() => void onWindowAction('panel')} aria-label="打开控制面板">
          面板 ↗
        </button>
        <button onClick={() => void onWindowAction('hide')} aria-label="隐藏伙伴">
          —
        </button>
      </div>
      <Device
        state={state}
        send={send}
        variant="compact"
        aiSession={ai}
        aiMode={aiMode}
        onAiMode={setAiMode}
        onAiSend={sendAi}
        onOpenPanel={() => void onWindowAction('panel')}
        work={work}
        bench={bench}
        idleLines={persona.idleLines}
        face={persona.face}
        senses={senses.config}
        reading={hearing}
        speaking={speech.speaking}
        voiceReady={stt.status === 'ready'}
        // 按下麦克风前先闭嘴：它念的话会从扬声器进麦克风，转出来就成了「我自己在念」。
        onBeforeVoiceStart={speech.stop}
      />
      {ai.job && <JobStatus job={ai.job} compact />}
      {error && (
        <p className="pet-error" role="alert" data-pet-interactive>
          {error}
        </p>
      )}
      {problem && (
        <button
          className="pet-error"
          data-pet-interactive
          onClick={() => void onWindowAction('panel')}
        >
          存储或操作异常 · 打开面板查看
        </button>
      )}
    </main>
  );
}
