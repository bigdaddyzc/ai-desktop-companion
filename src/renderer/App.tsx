import { appVersion } from '../core/version';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  sessionLabels,
  terminalStatuses,
  type Action,
  type AppState,
  type SessionKind,
  type SimulationEvent,
  type TaskStatus,
} from '../core/schema';
import { inputMappings, inputSpec } from '../core/input';
import { formatDuration, remainingMs } from '../core/state';
import { Device } from './Device';
import { AiPanel } from './AiPanel';
import { CompanionPanel, ConfirmBanner } from './CompanionPanel';
import { parseDue } from '../core/due';
import { dueLabel } from '../core/device-view';
import { PetWindow } from './PetWindow';
import { useCompanion } from './bridge';
import { usePersona } from './usePersona';
import { useSensesSnapshot } from './useSensesState';

type Send = (action: Action) => Promise<boolean>;
const modes: SessionKind[] = ['coding', 'design', 'document', 'entertainment'];
const symbols = ['⌘', '◈', '▤', '✦'];

function Sessions({ state, send }: { state: AppState; send: Send }) {
  const [title, setTitle] = useState('');
  return (
    <section className="card">
      <div className="section-heading">
        <h2>此刻，在做什么？</h2>
        <span className="label">手动会话</span>
      </div>
      <p className="muted">主动告诉伙伴你的状态，不读取其他应用。</p>
      <div className="mode-grid">
        {modes.map((kind, index) => (
          <button
            key={kind}
            className={`mode ${state.session.kind === kind ? 'selected' : ''}`}
            aria-pressed={state.session.kind === kind}
            onClick={() => void send({ type: 'session.set', kind, title: sessionLabels[kind] })}
          >
            <span aria-hidden="true">{symbols[index]}</span>
            {sessionLabels[kind]}
          </button>
        ))}
      </div>
      <form
        className="input-row"
        onSubmit={async (event) => {
          event.preventDefault();
          if (
            title.trim() &&
            (await send({ type: 'session.set', kind: state.session.kind, title }))
          )
            setTitle('');
        }}
      >
        <input
          aria-label="会话名称"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={100}
          placeholder="给这一段时间起个名字…"
        />
        <button type="submit" disabled={!title.trim()}>
          更新
        </button>
      </form>
      <div className="current-session">
        <span>当前：{state.session.title}</span>
        {state.session.kind !== 'idle' && (
          <button
            className="text-button"
            onClick={() =>
              void send({ type: 'session.set', kind: 'idle', title: sessionLabels.idle })
            }
          >
            结束会话
          </button>
        )}
      </div>
    </section>
  );
}

function Focus({ state, send }: { state: AppState; send: Send }) {
  const [minutes, setMinutes] = useState(25);
  const timer = state.timer;
  return (
    <section className="card focus-card">
      <div className="section-heading">
        <h2>给自己一段专注</h2>
        <span className="label">离线可用</span>
      </div>
      <div className="focus-row">
        <div>
          <div className="timer-digits" data-testid="timer">
            {formatDuration(timer ? remainingMs(timer, state.now) : minutes * 60_000)}
          </div>
          <span className="muted">
            {!timer
              ? '不赶进度，只陪你开始'
              : {
                  running: '专注进行中',
                  paused: '已暂停',
                  recovery:
                    (timer.recoveryReason ?? 'restart') === 'clock-jump'
                      ? '检测到休眠或时间跳变，请确认是否继续'
                      : '应用已重启，请确认是否继续',
                  completed: '计时结束，不代表任务完成',
                }[timer.status]}
          </span>
        </div>
        <div className="timer-actions">
          {!timer ? (
            <>
              <label className="minutes-label">
                分钟{' '}
                <input
                  aria-label="专注分钟"
                  type="number"
                  min={1}
                  max={180}
                  step={1}
                  value={Number.isNaN(minutes) ? '' : minutes}
                  onChange={(event) => setMinutes(event.target.valueAsNumber)}
                />
              </label>
              <button
                className="primary"
                disabled={!Number.isInteger(minutes) || minutes < 1 || minutes > 180}
                onClick={() => void send({ type: 'timer.start', minutes })}
              >
                开始专注
              </button>
            </>
          ) : (
            <>
              {timer.status === 'running' && (
                <button className="primary" onClick={() => void send({ type: 'timer.pause' })}>
                  暂停计时
                </button>
              )}
              {['paused', 'recovery'].includes(timer.status) && (
                <button className="primary" onClick={() => void send({ type: 'timer.resume' })}>
                  继续计时
                </button>
              )}
              <button onClick={() => void send({ type: 'timer.cancel' })}>
                {timer.status === 'completed' ? '收下提醒' : '结束计时'}
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function Todos({ state, send }: { state: AppState; send: Send }) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [dueError, setDueError] = useState('');
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  async function add(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || saving) return;
    setDueError('');
    let dueAt: number | undefined;
    if (due !== '') {
      const parsed = parseDue(due, Date.now());
      if (!parsed.ok) {
        setDueError(parsed.error);
        return;
      }
      dueAt = parsed.at;
    }
    setSaving(true);
    if (await send({ type: 'todo.add', title, ...(dueAt !== undefined ? { dueAt } : {}) })) {
      setTitle('');
      setDue('');
    }
    setSaving(false);
  }
  return (
    <section className="card">
      <div className="section-heading">
        <h2>把小事放在这里</h2>
        <span className="label">个人待办 · 本地保存</span>
      </div>
      <form className="input-row" onSubmit={(event) => void add(event)}>
        <input
          aria-label="新待办"
          placeholder="下一件想完成的小事"
          value={title}
          maxLength={100}
          onChange={(event) => setTitle(event.target.value)}
        />
        <input
          type="datetime-local"
          aria-label="到点提醒（可选）"
          title="到点时它会在小屏上主动提醒（可选）"
          value={due}
          onChange={(event) => setDue(event.target.value)}
        />
        <button type="submit" disabled={saving || !title.trim()}>
          {saving ? '保存中…' : '添加待办'}
        </button>
      </form>
      {dueError && (
        <p className="error-text" role="alert">
          {dueError}
        </p>
      )}
      {state.todos.length === 0 ? (
        <div className="empty-state">
          留一点空白，也挺好。<small>添加后才会写入本地；不会上传云端。</small>
        </div>
      ) : (
        <ul className="todo-list">
          {state.todos.map((todo) => (
            <li key={todo.id}>
              <label className={todo.done ? 'done' : ''}>
                <input
                  type="checkbox"
                  checked={todo.done}
                  onChange={() => void send({ type: 'todo.toggle', id: todo.id })}
                />
                <span>{todo.title}</span>
                {typeof todo.dueAt === 'number' && (
                  <small
                    className={`todo-due ${!todo.done && todo.dueAt <= state.now ? 'overdue' : ''}`}
                    data-testid="todo-due"
                  >
                    ⏰ {dueLabel(todo.dueAt, state.now)}
                  </small>
                )}
              </label>
              {removing === todo.id ? (
                <div className="inline-actions">
                  <button
                    className="danger-text"
                    onClick={async () => {
                      await send({ type: 'todo.remove', id: todo.id });
                      setRemoving(null);
                    }}
                  >
                    确认删除
                  </button>
                  <button onClick={() => setRemoving(null)}>取消</button>
                </div>
              ) : (
                <button
                  className="text-button"
                  aria-label={`删除待办：${todo.title}`}
                  onClick={() => setRemoving(todo.id)}
                >
                  删除
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Simulator({ state, send }: { state: AppState; send: Send }) {
  const lastEvent = useRef<SimulationEvent | null>(null);
  const [selected, setSelected] = useState('');
  const [mappingMessage, setMappingMessage] = useState('');
  const [replayMessage, setReplayMessage] = useState('');
  const task =
    state.simulation.tasks.find((item) => item.id === selected) ?? state.simulation.tasks[0];
  const statusLabels: Record<TaskStatus, string> = {
    running: '进行中',
    waiting: '等待确认',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };
  async function emit(status: TaskStatus, create = false, progress = false) {
    const taskId = create || !task ? crypto.randomUUID() : task.id;
    const event: SimulationEvent = {
      schemaVersion: 1,
      simulation: true,
      eventId: crypto.randomUUID(),
      sourceId: 'local-simulator',
      taskId,
      sequence: create || !task ? 1 : task.sequence + 1,
      title: create || !task ? `${sessionLabels[state.session.kind]}示例任务` : task.title,
      status,
      ...(progress ? { progress: { completed: 2, total: 5 } } : {}),
    };
    if (await send({ type: 'sim.event', event })) {
      lastEvent.current = event;
      setSelected(taskId);
    }
  }
  const locked = !state.simulation.connected;
  return (
    <>
      <section className="notice simulation-notice">
        <b>这是一块模拟沙盒</b>
        <p>不会执行命令，不会连接 IDE，也不会影响个人待办。以下任务和事件退出应用后清空。</p>
      </section>
      <section className="card">
        <div className="section-heading">
          <h2>给伙伴一个工作信号</h2>
          <span className="label amber">模拟来源</span>
        </div>
        <p className="muted">先新建任务，再发送状态。没有可靠完成量时不显示百分比。</p>
        <div className="button-row">
          <button className="primary" disabled={locked} onClick={() => void emit('running', true)}>
            新建模拟任务
          </button>
          <button
            onClick={() =>
              void send({ type: 'sim.connect', connected: !state.simulation.connected })
            }
          >
            {locked ? '恢复模拟连接' : '断开模拟连接'}
          </button>
          <button
            onClick={() => {
              lastEvent.current = null;
              setSelected('');
              void send({ type: 'sim.reset' });
            }}
          >
            重置沙盒
          </button>
        </div>
        {task && (
          <>
            <label className="select-label">
              当前模拟任务
              <select value={task.id} onChange={(event) => setSelected(event.target.value)}>
                {state.simulation.tasks.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title} · {item.id.slice(0, 6)}
                  </option>
                ))}
              </select>
            </label>
            <div className="button-row">
              {(['waiting', 'succeeded', 'failed', 'cancelled'] as const).map((status) => (
                <button
                  key={status}
                  disabled={locked || terminalStatuses.includes(task.status)}
                  onClick={() => void emit(status)}
                >
                  {statusLabels[status]}
                </button>
              ))}
              <button
                disabled={locked || terminalStatuses.includes(task.status)}
                onClick={() => void emit('running', false, true)}
              >
                已完成 2/5
              </button>
              {task.status === 'waiting' && (
                <button
                  disabled={locked}
                  onClick={() => void send({ type: 'sim.acknowledge', taskId: task.id })}
                >
                  确认此提示
                </button>
              )}
            </div>
          </>
        )}
        <div className="button-row debug-actions">
          <button
            disabled={!lastEvent.current || locked}
            onClick={() => {
              if (lastEvent.current) void send({ type: 'sim.event', event: lastEvent.current });
            }}
          >
            重发重复事件
          </button>
          <button
            disabled={!task || locked}
            onClick={() => {
              if (task)
                void send({
                  type: 'sim.event',
                  event: {
                    schemaVersion: 1,
                    simulation: true,
                    eventId: crypto.randomUUID(),
                    sourceId: 'local-simulator',
                    taskId: task.id,
                    sequence: 0,
                    title: task.title,
                    status: 'running',
                  },
                });
            }}
          >
            发送过期事件
          </button>
        </div>
      </section>
      <section className="card">
        <h2>模拟任务记录</h2>
        {state.simulation.tasks.length ? (
          <ul className="task-list">
            {state.simulation.tasks.map((item) => (
              <li key={item.id}>
                <span>
                  {item.title}
                  <small>
                    {item.id.slice(0, 6)} · seq {item.sequence}
                  </small>
                </span>
                <span className="label amber">
                  {locked ? '状态待确认' : statusLabels[item.status]}
                  {!locked && item.progress
                    ? ` · ${item.progress.completed}/${item.progress.total}`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">还没有模拟事件。先给伙伴一个信号吧。</p>
        )}
      </section>
      <section className="card">
        <h2>事件处理回放</h2>
        <p className="muted">最近 40 条，仅在内存中保留。不是七天审计日志。</p>
        <ol className="journal">
          {state.simulation.journal.map((line, index) => (
            <li key={`${index}-${line}`}>{line}</li>
          ))}
        </ol>
        <div className="button-row">
          <button
            onClick={async () => {
              try {
                const result = await window.companion!.exportReplay();
                setReplayMessage(result.ok ? '已导出回放脚本。' : (result.error ?? '导出已取消。'));
              } catch {
                setReplayMessage('回放脚本导出未完成。');
              }
            }}
          >
            导出回放脚本
          </button>
          <button
            onClick={async () => {
              try {
                const result = await window.companion!.importReplay();
                setReplayMessage(
                  result.ok ? `已按原规则回放 ${result.applied} 条事件。` : result.error,
                );
              } catch {
                setReplayMessage('回放脚本导入未完成。');
              }
            }}
          >
            导入并回放
          </button>
        </div>
        <p role="status">{replayMessage}</p>
        <p className="muted">
          脚本最多 30
          条模拟事件，不含个人数据；导入会按去重、乱序与终态规则逐条重放，可用来复现一致性问题。
        </p>
      </section>
      <section className="card">
        <div className="section-heading">
          <h2>输入映射（F-03）</h2>
          <span className="label amber">交互规格 v{inputSpec.version}</span>
        </div>
        <p className="muted">
          长按阈值 {inputSpec.longPressMs}ms · 释放后去抖 {inputSpec.debounceMs}ms ·
          一次按下最多产生一个手势，长按不会补发短按。A/B 是外接业务按钮，板载 BOOT／RESET
          不参与映射。实体 GPIO 时序尚未验证。
        </p>
        <table className="mapping-table">
          <thead>
            <tr>
              <th>按钮</th>
              <th>手势</th>
              <th>动作标识</th>
              <th>桌面行为</th>
            </tr>
          </thead>
          <tbody>
            {inputMappings.map((item) => (
              <tr key={`${item.button}-${item.gesture}`}>
                <td>{item.button}</td>
                <td>{item.gesture === 'short' ? '短按' : `长按 ${inputSpec.longPressMs}ms`}</td>
                <td>{item.assigned ? item.action : '未分配'}</td>
                <td>{item.desktopEffect}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="button-row">
          <button
            onClick={async () => {
              try {
                const result = await window.companion!.exportMapping();
                setMappingMessage(result.ok ? '映射表已导出。' : (result.error ?? '导出已取消。'));
              } catch {
                setMappingMessage('映射表导出未完成。');
              }
            }}
          >
            导出映射表 JSON
          </button>
        </div>
        <p role="status">{mappingMessage}</p>
        <p className="muted">
          导出的是固定交互规格，不含个人数据或模拟事件；用于桌面与实体固件逐项对照。
        </p>
      </section>
    </>
  );
}

function Settings({
  state,
  send,
  report,
}: {
  state: AppState;
  send: Send;
  report: (error: string) => void;
}) {
  const [message, setMessage] = useState('');
  return (
    <>
      <section className="card">
        <h2>按你的节奏陪伴</h2>
        {(
          [
            ['alwaysOnTop', '伙伴窗口置顶', '默认关闭，不主动抢占工作窗口。'],
            ['quiet', '勿扰模式', '不发送计时系统通知，屏幕状态仍会更新。'],
            ['reducedMotion', '减少动画', '停止眨眼动画；系统减少动态效果设置也会生效。'],
            [
              'showLab',
              '显示模拟实验室',
              '开发调试用：手动造「任务在跑 / 等确认 / 失败」事件看伙伴怎么反应、回放脚本、导出按键规格给固件对照。日常用不到。',
            ],
          ] as const
        ).map(([key, title, subtitle]) => (
          <label className="setting-row" key={key}>
            <span>
              <b>{title}</b>
              <small>{subtitle}</small>
            </span>
            <input
              type="checkbox"
              checked={state.settings[key] ?? false}
              onChange={(event) =>
                void send({ type: 'settings.patch', patch: { [key]: event.target.checked } })
              }
            />
          </label>
        ))}
      </section>
      <section className="card">
        <h2>你的数据，留在本机</h2>
        <p className="muted">
          保存待办、会话、计时和设置。除了你在「问问伙伴」主动发送的对话，没有其它云请求；没有遥测、自动启动、屏幕录制或键盘监听。AI
          对话不写入这些文件，伙伴的预设台词仍标为本地。
        </p>
        <div className="button-row">
          <button
            onClick={async () => {
              try {
                const result = await window.companion!.exportData();
                setMessage(result.ok ? '已导出个人数据。' : '');
                if (result.error) report(result.error);
              } catch {
                report('导出未完成。');
              }
            }}
          >
            导出个人数据
          </button>
          <button
            onClick={async () => {
              try {
                const result = await window.companion!.importData();
                setMessage(result.ok ? '个人数据已导入，界面已同步。' : result.error);
              } catch {
                report('导入未完成。');
              }
            }}
          >
            导入个人数据…
          </button>
          <button
            className="danger-text"
            onClick={async () => {
              try {
                const result = await window.companion!.clearData();
                setMessage(result.ok ? '本地数据已清除。' : '');
                if (!result.ok) report(result.error);
              } catch {
                report('清除未完成。');
              }
            }}
          >
            清除本地数据…
          </button>
        </div>
        <p role="status">{message}</p>
      </section>
      <section className="card boundaries">
        <span className="eyebrow">PROTOTYPE 0.1</span>
        <h2>先体验，再走向硬件</h2>
        <p>
          硬件基准：ESP32-S3-DevKitC-1。屏幕和两个业务按钮为外接扩展件。概念图没有表达已核验的尺寸、引脚、USB
          位置或完整接线。
        </p>
        <p>
          当前是桌面产品交互原型，不是芯片指令集仿真，不运行 ESP32
          固件，也不证明与真机像素一致。已接入 DeepSeek 真实对话（需自行配置
          Key），但自动工作接入、音频、LVGL、固件与实机校准仍未实现。
        </p>
        <p>
          重连只清空陈旧模拟任务、保留回放；真实适配器的快照同步将在后续实现。多屏
          DPI、系统休眠和长期性能仍需验证。
        </p>
      </section>
    </>
  );
}

export function App() {
  const { snapshot, error, setError, send } = useCompanion();
  const persona = usePersona();
  // 面板只是读：采集在桌宠窗口，这里拿到的是它上报的读数。
  const senses = useSensesSnapshot();
  const [tab, setTab] = useState<'today' | 'companion' | 'simulator' | 'ai' | 'settings'>('today');
  // 模拟实验室默认藏起来：在「偏好与边界」里打开才出现在导航里。
  const showLab = snapshot?.state.settings.showLab === true;
  useEffect(() => {
    if (!showLab && tab === 'simulator') setTab('today');
  }, [showLab, tab]);
  const pet = new URLSearchParams(location.search).get('window') === 'companion';
  // 改 body 的 class 是副作用，放在 effect 里而不是渲染阶段。
  useEffect(() => {
    document.body.classList.toggle('pet-body', pet);
  }, [pet]);
  useEffect(() => {
    if (!pet) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const setIgnore = (ignore: boolean) => {
      document.body.dataset.passthrough = String(ignore);
      window.companion?.mousePassthrough(ignore);
    };
    const onMove = (event: MouseEvent) => {
      // forward 模式下用坐标命中测试，不依赖 event.target（穿透时可能是 html）。
      const element = document.elementFromPoint(event.clientX, event.clientY);
      const interactive = element?.closest('[data-pet-interactive]') != null;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (interactive) {
        setIgnore(false);
      } else {
        // 延迟一点再穿透，避免鼠标快速经过透明区时吞掉随后的点击。
        timer = setTimeout(() => setIgnore(true), 120);
      }
    };
    document.addEventListener('mousemove', onMove);
    return () => {
      document.removeEventListener('mousemove', onMove);
      if (timer !== undefined) clearTimeout(timer);
      setIgnore(false);
      delete document.body.dataset.passthrough;
    };
  }, [pet]);
  async function windowAction(action: 'panel' | 'companion' | 'hide' | 'quit') {
    try {
      await window.companion!.windowAction(action);
    } catch {
      setError('窗口操作未完成。');
    }
  }
  if (!snapshot)
    return (
      <main className="loading">
        <b>芯伴</b>
        <p>{error || '正在连接本地伙伴…'}</p>
      </main>
    );
  const state = snapshot.state;
  const problem = error || snapshot.storageError;
  if (pet)
    return <PetWindow state={state} send={send} problem={problem} onWindowAction={windowAction} />;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-face">ı ı</span>
          <div>
            芯伴<small>一点陪伴，一起完成。</small>
          </div>
        </div>
        <div className="nav-label">会记事儿的桌面伙伴</div>
        <nav aria-label="主导航">
          {(
            [
              { key: 'today', icon: '◉', label: '此刻' },
              { key: 'companion', icon: '♡', label: '伙伴与设备' },
              { key: 'simulator', icon: '⌁', label: '模拟实验室' },
              { key: 'ai', icon: '✧', label: '问问伙伴' },
              { key: 'settings', icon: '⚙', label: '偏好与边界' },
            ] as const
          )
            .filter((item) => item.key !== 'simulator' || showLab)
            .map((item) => (
              <button
                key={item.key}
                className={tab === item.key ? 'active' : ''}
                aria-current={tab === item.key ? 'page' : undefined}
                onClick={() => setTab(item.key)}
              >
                <span>{item.icon}</span>
                {item.label}
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="local-indicator">
            <i />
            本地运行 · 按需出站
          </span>
          <p>
            不用买硬件，
            <br />
            先把它养成自己的。
          </p>
          <button className="text-button" onClick={() => void windowAction('quit')}>
            退出芯伴 ↗
          </button>
        </div>
      </aside>
      <main className="workspace">
        <header className="page-header">
          <div>
            <span className="eyebrow">YOUR LITTLE DESKTOP COMPANION</span>
            <h1>
              {tab === 'today'
                ? '认真做事，也好好休息。'
                : tab === 'companion'
                  ? '该开口时开口。'
                  : tab === 'simulator'
                    ? '看看伙伴，如何回应。'
                    : tab === 'ai'
                      ? '问问伙伴，也说给自己听。'
                      : '陪伴，不越界。'}
            </h1>
            <p>
              {tab === 'today'
                ? '今天的小目标，我们一起慢慢完成。'
                : tab === 'companion'
                  ? '它什么时候找你、动手前问了什么、桌角那块屏连上没有。'
                  : tab === 'simulator'
                    ? '用可追溯的事件驱动状态，而不是让 AI 猜测。'
                    : tab === 'ai'
                      ? '真实云服务接入；发送什么由你决定，不自动采集本地内容。'
                      : '保持安静、透明，把选择权留给你。'}
            </p>
          </div>
          <button className="show-pet" onClick={() => void windowAction('companion')}>
            显示桌面伙伴 ↗
          </button>
        </header>
        {problem && (
          <div className="error-banner" role="alert">
            {problem}
          </div>
        )}
        <ConfirmBanner />
        <div className="content-grid">
          <aside className="preview-column">
            <div className="device-stage">
              <span className="stage-kicker">
                伙伴预览 <span>实时同步</span>
              </span>
              <Device
                state={state}
                send={send}
                idleLines={persona.idleLines}
                face={persona.face}
                senses={senses.config}
                reading={senses.reading}
              />
              <div className="stage-note">
                <b>一块小屏，一点默契。</b>
                <span>这里与桌面窗口共享同一份状态。</span>
              </div>
            </div>
            <div className="preview-footnote">
              <span className="label">桌面体验原型</span>
              <p>
                A 短按：允许 / 接住提醒 / 摸摸伙伴 / 游戏确认
                <br />
                B 短按：拒绝 / 知道了 / 开始或退出反应小游戏
                <br />
                B 长按 800ms：切换勿扰 · A 长按暂未分配
                <br />
                实体小屏在「伙伴与设备」里启用；AI 对话需在「问问伙伴」配置后使用。
              </p>
            </div>
          </aside>
          <div className="controls">
            {tab === 'today' ? (
              <>
                <Sessions state={state} send={send} />
                <Focus state={state} send={send} />
                <Todos state={state} send={send} />
              </>
            ) : tab === 'companion' ? (
              <CompanionPanel />
            ) : tab === 'simulator' ? (
              <Simulator state={state} send={send} />
            ) : tab === 'ai' ? (
              <AiPanel />
            ) : (
              <Settings state={state} send={send} report={setError} />
            )}
          </div>
        </div>
        <footer className="workspace-footer">
          芯伴 {appVersion} <span>概念装配 · 手动工作会话 · 模拟事件沙盒</span>
        </footer>
      </main>
    </div>
  );
}
