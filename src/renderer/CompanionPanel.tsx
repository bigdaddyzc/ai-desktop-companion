import { useEffect, useState } from 'react';
import { confirmOutcomeLabels, secondsLeft, type ConfirmSnapshot } from '../core/confirm';
import type { DeviceConfig, DeviceSnapshot } from '../core/device-protocol';
import {
  nudgeGroupLabels,
  type NudgeGroup,
  type ProactiveConfig,
  type ProactiveSnapshot,
} from '../core/proactive';
import { formatClock } from '../core/state';
import { useConfirm, useDevice, useMusic, useProactive } from './useLive';
import { musicLine } from '../core/music';
import {
  iotDisplay,
  iotDisplayLabels,
  iotKindLabels,
  iotKinds,
  iotLimits,
  type IotDeviceConfig,
  type IotKind,
} from '../core/iot';
import { storyRequest } from '../core/persona';
import { useWorkProgress } from './useWorkProgress';
import { defaultAgentSources, type AgentSourcesConfig } from '../core/agent-logs';
import type { HookTarget, HookTargetStatus, HooksStatus } from '../core/hook-install';
import { lostText, type HookWatchSnapshot } from '../core/hook-watch';
import type { HealthSnapshot } from '../core/app-log';
import { shortActivity } from '../core/progress';
import { autoApprovalText, type ApprovalGrant, type ApprovalView } from '../core/auto-approve';
import { remoteApproveLimits, type RemoteApproveConfig } from '../core/agent-permission';
import { WorkbenchCard } from './WorkbenchCard';
import { PhonePushCard } from './PhonePushCard';
import { UsageStats } from './UsageStats';
import { SetupCard } from './SetupCard';
import { LanScanCard } from './LanScanCard';

/**
 * 「伙伴与设备」：确认、主动开口、关系、实体设备四张卡。
 *
 * 都是「它和你之间」的事：它什么时候开口、动手前问了什么、你们认识多久了、
 * 桌角那块实体屏连没连上。和「问问伙伴」（对话与能力配置）分开放。
 */
export function CompanionPanel() {
  const confirm = useConfirm();
  const proactive = useProactive();
  const device = useDevice();
  return (
    <>
      <SetupCard />
      <WorkbenchCard />
      <ConfirmCard confirm={confirm} />
      <ProactiveCard proactive={proactive} />
      <CompanyCard />
      <HooksCard />
      <RemoteApproveCard />
      <PhonePushCard />
      <ApprovalsCard />
      <AgentSourcesCard />
      <BondCard proactive={proactive} />
      <DeviceCard device={device} />
      <LanScanCard device={device} />
      <IotCard device={device} />
      <HealthCard />
    </>
  );
}

const healthEventText: Record<string, string> = {
  'ai-turn': '对话没成功',
  delegate: '派活没成功',
  'hooks-lost': '钩子被拆了',
  'hooks-repair-failed': '钩子没装回去',
  uncaught: '程序异常',
  'unhandled-rejection': '程序异常',
  'renderer-gone': '窗口崩了',
  'child-gone': '子进程退出',
};

/** 运行健康：本次启动以来出过什么问题、日志在哪。出事时不用猜，点开日志目录就能发给别人看。 */
function HealthCard() {
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void window
      .companion!.health()
      .then((next) => {
        if (alive) setHealth(next);
      })
      .catch(() => undefined);
    const off = window.companion!.onHealth((next) => setHealth(next));
    return () => {
      alive = false;
      off();
    };
  }, []);
  if (!health) return null;
  const fine = health.errors === 0 && health.warnings === 0;
  return (
    <section className="card" data-testid="health-card">
      <div className="section-heading">
        <h2>运行状况</h2>
        <span className="label">
          v{health.version} · {formatClock(health.startedAt)} 启动
        </span>
      </div>
      <p className={fine ? 'muted' : ''} data-testid="health-summary">
        {fine
          ? '这次启动以来一切正常。'
          : `这次启动以来：${health.errors} 个错误、${health.warnings} 个告警。`}
        日志只记发生了什么（事件、耗时、错误摘要），不记对话内容和密钥，留 7 天。
      </p>
      {health.writeFailed && (
        <p className="error-text" role="alert">
          日志写不进去（磁盘满了或没有权限），出了问题会查不到痕迹。
        </p>
      )}
      <UsageStats />
      {health.recent.length > 0 && (
        <ul className="plain-list" data-testid="health-recent">
          {health.recent.map((item) => (
            <li key={`${item.at}:${item.event}`}>
              <small className="muted">
                {formatClock(item.at)} · {item.level === 'error' ? '错误' : '告警'} ·{' '}
                {healthEventText[item.event] ?? item.event}
                {typeof item.fields['error'] === 'string' ? `：${item.fields['error']}` : ''}
              </small>
            </li>
          ))}
        </ul>
      )}
      <div className="inline-actions">
        <button
          type="button"
          onClick={() =>
            void window
              .companion!.healthOpenLogs()
              .then((result) => setError(result.ok ? '' : (result.error ?? '打不开。')))
          }
        >
          打开日志目录
        </button>
        <small className="muted">{health.logDir}</small>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** 面板顶部的确认横条：不管在哪个页，它在等你时都看得见。 */
export function ConfirmBanner() {
  const confirm = useConfirm();
  const pending = confirm.pending;
  // 倒数要动：挂着时每秒重算一次，没有待确认时不跑定时器。
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => setTick((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [pending]);
  if (!pending) return null;
  return (
    <div
      className="confirm-banner"
      role="alertdialog"
      aria-label="它在等你确认"
      data-testid="confirm-banner"
    >
      <div>
        <b>{pending.title}</b>
        <code>{pending.detail}</code>
        <small>
          {secondsLeft(pending, Date.now())}
          {pending.external ? ' 秒内不回答就交回终端' : ' 秒内不回答就算拒绝'}
          {confirm.queued > 0 ? ` · 后面还排着 ${confirm.queued} 条` : ''}
        </small>
      </div>
      <div className="inline-actions">
        <button
          className="primary"
          onClick={() => void window.companion!.confirmAnswer(pending.id, true)}
        >
          允许
        </button>
        <button onClick={() => void window.companion!.confirmAnswer(pending.id, false)}>
          拒绝
        </button>
        {pending.external?.canRemember && (
          <button
            data-testid="confirm-remember"
            onClick={() => void window.companion!.confirmExternal(pending.id, 'remember')}
          >
            以后同类都批
          </button>
        )}
        {pending.external && (
          <button
            data-testid="confirm-defer"
            onClick={() => void window.companion!.confirmExternal(pending.id, 'defer')}
          >
            交回终端
          </button>
        )}
      </div>
    </div>
  );
}

function ConfirmCard({ confirm }: { confirm: ConfirmSnapshot }) {
  return (
    <section className="card" data-testid="confirm-card">
      <div className="section-heading">
        <h2>动手前先问你</h2>
        <span className="label">跑命令 · 看屏幕/摄像头 · 派活</span>
      </div>
      <p className="muted">
        这几类动作每次都要你点头：小屏上按 A 允许、B 拒绝，或在这里点。一分钟不回就当拒绝——
        宁可不做，也不替你做主。这是代码里的门，不是提示词里的嘱咐。Claude Code / WorkBuddy
        的权限请求（远程批准）也在这里问，没人理就交回终端。
      </p>
      {confirm.recent.length === 0 ? (
        <div className="empty-state">还没问过你。</div>
      ) : (
        <ul className="plain-list">
          {confirm.recent.map((item) => (
            <li key={item.id}>
              <span>
                {item.title} <code>{item.detail}</code>
              </span>
              <small className={`outcome-${item.outcome}`}>
                {formatClock(item.at)} · {confirmOutcomeLabels[item.outcome]}
              </small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const outcomeText = { accepted: '你接了', dismissed: '你说知道了', expired: '没人理' } as const;

function ProactiveCard({ proactive }: { proactive: ProactiveSnapshot }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // 同 DeviceCard：存盘期间显示刚选的值，失败回到真实值。
  const [draft, setDraft] = useState<ProactiveConfig | null>(null);
  const config = draft ?? proactive.config;
  async function save(next: ProactiveConfig) {
    setDraft(next);
    setSaving(true);
    setError('');
    try {
      const result = await window.companion!.proactiveSave(next);
      if (!result.ok) setError(result.error ?? '没保存上。');
    } catch {
      setError('没保存上。');
    } finally {
      setDraft(null);
      setSaving(false);
    }
  }
  const accepted = proactive.history.filter((item) => item.outcome === 'accepted').length;
  return (
    <section className="card" data-testid="proactive-card">
      <div className="section-heading">
        <h2>它会主动开口</h2>
        <span className="label">本地触发 · 不自动调用 AI</span>
      </div>
      <p className="muted">
        AI 干完活、在等你、待办到点、早上第一次见面时，它会在小屏上说一句。台词是本地按性格挑的，
        不出站；你按 A「细说」才会发起一次 AI 对话。每小时最多 4 句，你忽略的那类会自动少说。
      </p>
      <label className="toggle-row">
        <input
          type="checkbox"
          aria-label="允许它主动开口"
          checked={config.enabled}
          disabled={saving}
          onChange={(event) => void save({ ...config, enabled: event.target.checked })}
        />
        <span>允许它主动开口</span>
      </label>
      {(Object.keys(nudgeGroupLabels) as NudgeGroup[]).map((group) => (
        <label className="toggle-row nested" key={group}>
          <input
            type="checkbox"
            checked={config.groups[group]}
            disabled={saving || !config.enabled}
            onChange={(event) =>
              void save({ ...config, groups: { ...config.groups, [group]: event.target.checked } })
            }
          />
          <span>{nudgeGroupLabels[group]}</span>
        </label>
      ))}
      <label className="toggle-row nested">
        <input
          type="checkbox"
          checked={config.speak}
          disabled={saving || !config.enabled}
          onChange={(event) => void save({ ...config, speak: event.target.checked })}
        />
        <span>开口时也念出来（需要「它会出声」已打开；勿扰时不念）</span>
      </label>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <h3 className="subheading">
        最近说过的话
        {proactive.history.length > 0 && (
          <small>
            {' '}
            · 你接了 {accepted}/{proactive.history.length}
          </small>
        )}
      </h3>
      {proactive.history.length === 0 ? (
        <div className="empty-state">它还没主动找过你。</div>
      ) : (
        <ul className="plain-list" data-testid="nudge-history">
          {proactive.history.slice(0, 10).map((item) => (
            <li key={item.id}>
              <span>{item.text}</span>
              <small>
                {formatClock(item.at)} · {outcomeText[item.outcome]}
              </small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function BondCard({ proactive }: { proactive: ProactiveSnapshot }) {
  const bond = proactive.bond;
  return (
    <section className="card" data-testid="bond-card">
      <div className="section-heading">
        <h2>你们认识第 {bond.dayNumber} 天</h2>
        <span className="label">只存本机 · 不进导出</span>
      </div>
      <dl className="stat-grid">
        <div>
          <dt>见过面</dt>
          <dd>{bond.daysTogether} 天</dd>
        </div>
        <div>
          <dt>连续</dt>
          <dd>
            {bond.streak} 天<small> · 最长 {bond.longestStreak}</small>
          </dd>
        </div>
        <div>
          <dt>一起划掉</dt>
          <dd>{bond.todosDone} 件</dd>
        </div>
        <div>
          <dt>一起专注</dt>
          <dd>{bond.focusMinutes} 分钟</dd>
        </div>
        <div>
          <dt>摸了它</dt>
          <dd>{bond.pets} 次</dd>
        </div>
        <div>
          <dt>今天</dt>
          <dd>
            划掉 {bond.today.todosDone} · 专注 {bond.today.focusMinutes} 分
          </dd>
        </div>
      </dl>
      <p className="muted">
        这些数字让它的语气带上熟悉度：摸摸的反应会变、早晚会打招呼、久别会说一句。
        问它时只带一句「你们认识第 N 天」这样的事实。
      </p>
    </section>
  );
}

/**
 * 陪你一会儿：音乐（控制你电脑上的音乐客户端）+ 讲故事（AI 现编，语音开着就念出来）。
 */
function CompanyCard() {
  const music = useMusic();
  const [theme, setTheme] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // 打开这张卡就算「用到音乐了」：第一次拉起系统媒体桥。
    void window.companion?.musicRefresh().catch(() => undefined);
  }, []);
  async function control(command: 'toggle' | 'next' | 'prev') {
    setNote('');
    try {
      const result = await window.companion!.musicControl(command);
      if (!result.ok) setNote(result.error);
    } catch {
      setNote('没按成。');
    }
  }
  async function story() {
    setBusy(true);
    setNote('');
    try {
      const result = await window.companion!.aiSend(storyRequest(theme));
      if (result.ok) {
        setTheme('');
        setNote('开始讲了，桌宠那边听（语音开着会念出来）。');
      } else setNote(result.error);
    } catch {
      setNote('没发出去。');
    } finally {
      setBusy(false);
    }
  }
  const now = music.nowPlaying;
  return (
    <section className="card" data-testid="company-card">
      <div className="section-heading">
        <h2>陪你一会儿</h2>
        <span className="label">音乐 · 讲故事</span>
      </div>
      <p className="muted" data-testid="music-now">
        {!music.available
          ? '这台电脑上用不了系统媒体控制（只支持 Windows）。'
          : now
            ? `${now.appLabel} · ${now.status === 'playing' ? '正在放' : '暂停中'} · ${musicLine(now).slice(2) || '（没报歌名）'}`
            : '没有音乐客户端在报告播放状态。先打开网易云 / QQ 音乐等放一首。'}
      </p>
      <div className="card-actions">
        <button type="button" onClick={() => void control('prev')} aria-label="上一首">
          ⏮
        </button>
        <button type="button" onClick={() => void control('toggle')} aria-label="播放或暂停">
          {now?.status === 'playing' ? '⏸ 暂停' : '▶ 播放'}
        </button>
        <button type="button" onClick={() => void control('next')} aria-label="下一首">
          ⏭
        </button>
      </div>
      <p className="muted">
        控制的是你电脑上已开着的客户端（经由 Windows
        系统媒体控制，和键盘上的播放键一样），会员和歌单都在客户端里。 也可以直接跟它说「换一首」。
      </p>
      <form
        className="card-actions"
        onSubmit={(event) => {
          event.preventDefault();
          void story();
        }}
      >
        <input
          aria-label="故事主题"
          value={theme}
          maxLength={60}
          placeholder="故事主题（可空）：小猫、太空、加班的程序员…"
          onChange={(event) => setTheme(event.target.value)}
        />
        <button type="submit" disabled={busy} data-testid="panel-story">
          ✦ 讲个故事
        </button>
      </form>
      {note && (
        <p className="muted" role="status">
          {note}
        </p>
      )}
    </section>
  );
}

const approvalSourceLabels: Record<ApprovalGrant['source'], string> = {
  'claude-code': 'Claude Code',
  workbuddy: 'WorkBuddy',
};

function projectName(project: string): string {
  return project.split(/[\\/]/).filter(Boolean).pop() ?? project;
}

/**
 * 远程批准：Claude Code / WorkBuddy 弹权限请求时，在桌宠/面板/实体键上答。
 * 等待期间终端不弹窗；超时、芯伴关掉、出错都交回终端，不替你决定。
 */
function RemoteApproveCard() {
  const [config, setConfig] = useState<RemoteApproveConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    window
      .companion!.remoteApproveState()
      .then((next) => {
        if (alive) setConfig(next);
      })
      .catch(() => {
        if (alive) setError('读不到远程批准的设置。');
      });
    return () => {
      alive = false;
    };
  }, []);
  async function save(next: RemoteApproveConfig) {
    setBusy(true);
    setError('');
    try {
      const result = await window.companion!.remoteApproveSave(next);
      if (result.ok) setConfig(result.config);
      else setError(result.error);
    } catch {
      setError('没改成，请重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card" data-testid="remote-approve-card">
      <div className="section-heading">
        <h2>远程批准</h2>
        <span className="label">Claude Code · WorkBuddy · CodeBuddy</span>
      </div>
      <p className="muted">
        对方弹权限请求时，桌宠和这里同时亮出确认卡，在哪里点都行。等待期间终端不弹窗；
        没人理、芯伴关了、出了错，都交回终端照常问你，不替你批也不替你拒。Codex
        没有能回传决定的钩子，还得回终端点。要先在上面装好（或重装）钩子。
      </p>
      <label className="toggle-row">
        <span>在芯伴上批准</span>
        <input
          type="checkbox"
          data-testid="remote-approve-enabled"
          checked={config?.enabled ?? false}
          disabled={busy || config === null}
          onChange={(event) => {
            if (config) void save({ ...config, enabled: event.target.checked });
          }}
        />
      </label>
      <label className="toggle-row">
        <span>等我多久</span>
        <select
          data-testid="remote-approve-wait"
          value={config?.waitMs ?? remoteApproveLimits.defaultWaitMs}
          disabled={busy || config === null}
          onChange={(event) => {
            if (config) void save({ ...config, waitMs: Number(event.target.value) });
          }}
        >
          {remoteApproveLimits.waitChoicesMs.map((ms) => (
            <option key={ms} value={ms}>
              {ms / 1_000} 秒
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * 替你确认：你批过一次的同类操作，芯伴之后替你点批准。
 * 高风险的永远问你；这里能看到芯伴学会了什么、替你批了什么，并随时撤销。
 */
function ApprovalsCard() {
  const [view, setView] = useState<ApprovalView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const work = useWorkProgress();
  // 收件箱一变（进度刷新）就重读一次：刚学会的、刚替你批的都能马上看到。
  useEffect(() => {
    let alive = true;
    window
      .companion!.approvalsState()
      .then((next) => {
        if (alive) setView(next);
      })
      .catch(() => {
        if (alive) setError('读不到替你确认的状态。');
      });
    return () => {
      alive = false;
    };
  }, [work.scannedAt]);
  async function run(
    action: () => Promise<{ ok: true; view: ApprovalView } | { ok: false; error: string }>,
  ) {
    setBusy(true);
    setError('');
    try {
      const result = await action();
      if (result.ok) setView(result.view);
      else setError(result.error);
    } catch {
      setError('没改成，请重试。');
    } finally {
      setBusy(false);
    }
  }
  const groups = new Map<string, ApprovalGrant[]>();
  for (const grant of view?.grants ?? []) {
    const id = `${grant.source}|${grant.project}`;
    groups.set(id, [...(groups.get(id) ?? []), grant]);
  }
  return (
    <section className="card" data-testid="approvals-card">
      <div className="section-heading">
        <h2>替你确认</h2>
        <span className="label">Claude Code · WorkBuddy · CodeBuddy</span>
      </div>
      <p className="muted">
        你在某个项目里亲手批过一次的同类操作（比如「npm test」「改文件」），之后芯伴替你点批准。
        删文件、git push / reset --hard /
        强制覆盖、装卸软件包、改项目外的文件、碰密钥、联网上传、认不出的命令，
        永远问你。芯伴没开时照常弹窗。要先在上面装好钩子。远程批准卡上点「以后同类都批」
        会加一条并打开这个开关。
      </p>
      <label className="toggle-row">
        <span>让芯伴替我确认</span>
        <input
          type="checkbox"
          data-testid="approvals-enabled"
          checked={view?.enabled ?? false}
          disabled={busy || view === null}
          onChange={(event) => {
            const enabled = event.target.checked;
            void run(() => window.companion!.approvalsEnable(enabled));
          }}
        />
      </label>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div data-testid="approvals-grants">
        {groups.size === 0 ? (
          <p className="muted">还没学会任何批准：在对方的弹窗里批一次，这里就会出现。</p>
        ) : (
          [...groups.entries()].map(([id, grants]) => (
            <div key={id} className="approval-group">
              <strong>
                {approvalSourceLabels[grants[0]!.source]} · {projectName(grants[0]!.project)}
              </strong>
              <small className="muted"> {grants[0]!.project}</small>
              {grants.map((grant) => (
                <div className="toggle-row hook-row" key={grant.key}>
                  <span>{grant.key}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => window.companion!.approvalsRevoke(grant))}
                  >
                    撤销
                  </button>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
      <p className="muted" data-testid="approvals-recent">
        {view && view.recent.length > 0
          ? view.recent
              .slice(0, 5)
              .map(
                (item) =>
                  `${new Date(item.at).toLocaleTimeString()} ${projectName(item.project)} ${autoApprovalText(item.keys)}`,
              )
              .join('；')
          : '芯伴还没替你批过任何操作。'}
      </p>
    </section>
  );
}

const hookStatusText: Record<HookTargetStatus['status'], string> = {
  installed: '已安装',
  partial: '只装了一部分，建议重装',
  absent: '未安装',
  conflict: '已有你自己的 notify，未动',
  unreadable: '配置文件读不懂，未动',
};

/**
 * 官方通知钩子：让 Claude Code / Codex 主动告诉芯伴「在等你」「做完了」。
 * 会改你自己的配置文件，所以只在你点按钮时动，改前自动备份。
 */
function HooksCard() {
  const [status, setStatus] = useState<HooksStatus | null>(null);
  const [watch, setWatch] = useState<HookWatchSnapshot | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const work = useWorkProgress();
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      window
        .companion!.hooksStatus()
        .then((next) => {
          if (alive) setStatus(next);
        })
        .catch(() => {
          if (alive) setError('读不到钩子状态。');
        });
    void refresh();
    void window
      .companion!.hooksWatchState()
      .then((next) => {
        if (alive) setWatch(next);
      })
      .catch(() => undefined);
    // 自检结果变了（丢了、修好了），状态行也跟着刷新。
    const off = window.companion!.onHooksWatch((next) => {
      setWatch(next);
      void refresh();
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  async function repair() {
    setBusy('repair');
    setError('');
    try {
      const result = await window.companion!.hooksRepair();
      if (!result.ok) setError(result.error ?? '没装上。');
      setStatus(await window.companion!.hooksStatus());
    } catch {
      setError('没装上，请重试。');
    } finally {
      setBusy('');
    }
  }
  async function apply(target: HookTarget, action: 'install' | 'uninstall') {
    setBusy(`${target}:${action}`);
    setError('');
    try {
      const result = await window.companion!.hooksApply(target, action);
      if (result.ok) setStatus(result.status);
      else setError(result.error);
    } catch {
      setError('没改成，请重试。');
    } finally {
      setBusy('');
    }
  }
  const rows: {
    target: HookTarget;
    name: string;
    key: 'claudeCode' | 'codex' | 'workbuddy' | 'codebuddy';
    what: string;
  }[] = [
    {
      target: 'claude-code',
      name: 'Claude Code',
      key: 'claudeCode',
      what: '等你批准、做完一轮、会话开关都会报',
    },
    {
      target: 'codex',
      name: 'Codex',
      key: 'codex',
      what: '只报「做完一轮」（Codex 的 notify 只有这一种）',
    },
    {
      target: 'workbuddy',
      name: 'WorkBuddy',
      key: 'workbuddy',
      what: '桌面版。和 Claude Code 同一套钩子：等你批准、做完一轮、会话开关',
    },
    {
      target: 'codebuddy',
      name: 'CodeBuddy 命令行',
      key: 'codebuddy',
      what: '芯伴把活派给 WorkBuddy 时跑的就是它；配置和桌面版分开存',
    },
  ];
  const signalled = work.sessions.filter((session) => session.signal !== undefined);
  return (
    <section className="card" data-testid="hooks-card">
      <div className="section-heading">
        <h2>官方通知钩子</h2>
        <span className="label">推荐 · 只报状态不报内容</span>
      </div>
      <p className="muted">
        装上后由 Claude Code / Codex / WorkBuddy
        主动告诉芯伴「在等你确认」「这轮做完了」，比读日志准、不怕格式变。
        只记事件名、会话、目录和工具名，不记你们的对话。会改你的配置文件，改前自动备份；装完对新开的会话生效。
      </p>
      {status && !status.node && (
        <p className="error-text" role="alert">
          没找到 node：钩子靠 node 运行，请先安装 Node.js 并确保在 PATH 里。
        </p>
      )}
      {watch && watch.lost.length > 0 && (
        <div className="confirm-banner" role="alert" data-testid="hooks-lost">
          <div>
            <b>{lostText(watch.lost)} 的钩子被拆掉了</b>
            <small>
              常见原因：cc-switch 这类工具在恢复配置时把 settings.json
              整个还原了。不装回去，芯伴就看不到它在等你、做完了。
              {watch.consent === 'ask' ? ' 装回一次即视为同意，之后再丢会自动装回。' : ''}
            </small>
          </div>
          <div className="inline-actions">
            <button className="primary" disabled={busy !== ''} onClick={() => void repair()}>
              装回去
            </button>
          </div>
        </div>
      )}
      {watch && watch.blocked.length > 0 && (
        <p className="error-text" role="alert">
          {lostText(watch.blocked)} 的配置文件现在读不懂或有你自己的
          notify，芯伴没动它；钩子暂时不在。
        </p>
      )}
      {watch && (
        <p className="muted" data-testid="hooks-watch">
          自检：每 5 分钟看一次你装过的钩子还在不在（
          {watch.expected.length > 0 ? lostText(watch.expected) : '还没装过'}）。丢了时
          {watch.consent === 'auto' ? '自动装回去并告诉你' : '先问你'}。
          {watch.consent === 'auto' && (
            <button
              type="button"
              className="link-button"
              onClick={() => void window.companion!.hooksConsent('ask')}
            >
              改回每次先问我
            </button>
          )}
          {watch.lastRepair
            ? ` 上次${watch.lastRepair.auto ? '自动' : ''}装回：${new Date(watch.lastRepair.at).toLocaleString()}（${
                watch.lastRepair.ok ? '成功' : watch.lastRepair.error
              }）。`
            : ''}
        </p>
      )}
      {rows.map((row) => {
        const item = status?.[row.key];
        const installed = item?.status === 'installed';
        const blocked = item?.status === 'conflict' || item?.status === 'unreadable';
        return (
          <div className="toggle-row hook-row" key={row.target} data-testid={`hooks-${row.target}`}>
            <span>
              <strong>{row.name}</strong>：{item ? hookStatusText[item.status] : '…'}
              <br />
              <small className="muted">
                {row.what}
                {item?.note ? ` · ${item.note}` : ''}
                {item ? ` · ${item.path}` : ''}
              </small>
            </span>
            <button
              type="button"
              disabled={busy !== '' || !item || blocked}
              onClick={() => void apply(row.target, installed ? 'uninstall' : 'install')}
            >
              {installed ? '卸载' : item?.status === 'partial' ? '重装' : '安装'}
            </button>
          </div>
        );
      })}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <p className="muted" data-testid="hooks-live">
        {signalled.length > 0
          ? signalled
              .map(
                (session) =>
                  `${session.source ?? ''} · ${session.project} · ${shortActivity(session)}`,
              )
              .join('；')
          : status && status.lastEventAt > 0
            ? `最近一次收到事件：${new Date(status.lastEventAt).toLocaleString()}`
            : '还没收到过钩子事件。'}
      </p>
    </section>
  );
}

/**
 * 盯哪些 AI：WorkBuddy 一直在看；Claude Code / Codex 由你开。
 * 开了之后，它们停下、在等你时小屏会说一句；你问芯伴时，进度摘要也会随提问发给模型。
 */
function AgentSourcesCard() {
  const work = useWorkProgress();
  const [draft, setDraft] = useState<AgentSourcesConfig | null>(null);
  const [error, setError] = useState('');
  const config = draft ?? work.sources ?? defaultAgentSources;
  async function save(next: AgentSourcesConfig) {
    setDraft(next);
    setError('');
    try {
      const result = await window.companion!.workSourcesSave(next);
      if (!result.ok) setError(result.error ?? '没保存上。');
    } catch {
      setError('没保存上。');
    } finally {
      setDraft(null);
    }
  }
  const live = work.sessions.filter((session) => session.status === 'working');
  return (
    <section className="card" data-testid="agent-sources-card">
      <div className="section-heading">
        <h2>读会话日志（备用）</h2>
        <span className="label">只读本机记录 · 不改对方文件</span>
      </div>
      <p className="muted">
        它们跑完、卡住、在等你回话时，小屏会主动说一句。打开后，你问芯伴时它们的进度摘要
        （项目名、最近一句话）会随提问发给模型。
      </p>
      <label className="toggle-row">
        <input type="checkbox" checked disabled aria-label="WorkBuddy" />
        <span>WorkBuddy（~/.workbuddy）</span>
      </label>
      <label className="toggle-row">
        <input
          type="checkbox"
          aria-label="盯着 Claude Code"
          checked={config.claudeCode}
          onChange={(event) => void save({ ...config, claudeCode: event.target.checked })}
        />
        <span>Claude Code（~/.claude/projects）</span>
      </label>
      <label className="toggle-row">
        <input
          type="checkbox"
          aria-label="盯着 Codex"
          checked={config.codex}
          onChange={(event) => void save({ ...config, codex: event.target.checked })}
        />
        <span>Codex（~/.codex/sessions）</span>
      </label>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <p className="muted" data-testid="agent-sources-live">
        {live.length === 0
          ? '此刻没有正在干活的会话。'
          : live
              .map((session) => `${session.source ?? 'WorkBuddy'} · ${session.project}`)
              .join('；')}
      </p>
    </section>
  );
}

const blankIotDevice: IotDeviceConfig = {
  id: '',
  name: '',
  kind: 'tasmota',
  host: '',
  channel: '',
};

/**
 * 家里的设备：ESP32 当中枢，控制同一 Wi-Fi 下的智能插座/开关并实时回报。
 * 这里只登记与显示；轮询和开关由中枢做，电脑关了它也照常工作。
 */
function IotCard({ device }: { device: DeviceSnapshot }) {
  const iot = device.iot;
  const [now, setNow] = useState(() => Date.now());
  const [form, setForm] = useState<IotDeviceConfig>(blankIotDevice);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 状态新不新鲜靠时间判断：中枢掉线时每秒重算一次，把「开着」及时变成「不确定」。
  useEffect(() => {
    if (iot.config.devices.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [iot.config.devices.length]);
  async function save(devices: IotDeviceConfig[]): Promise<boolean> {
    setBusy(true);
    setError('');
    try {
      const result = await window.companion!.iotSave({ devices });
      if (!result.ok) setError(result.error ?? '没保存上。');
      return result.ok;
    } catch {
      setError('没保存上。');
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function toggle(id: string, on: boolean) {
    setError('');
    try {
      const result = await window.companion!.iotSet(id, on);
      if (!result.ok) setError(result.error ?? '没发出去。');
    } catch {
      setError('没发出去。');
    }
  }
  const net = iot.net;
  const hubText = !iot.hub
    ? device.status === 'connected'
      ? '已连上的设备不支持物联网（固件没声明 iot 能力）'
      : '中枢不在线：先在上面「实体小屏」里连上 ESP32'
    : !net
      ? '中枢在线，等它报 Wi-Fi 状态…'
      : net.ok
        ? `中枢在线 · Wi-Fi ${net.ssid || '已连接'}${net.ip ? ` · ${net.ip}` : ''}${net.rssi !== null ? ` · 信号 ${net.rssi}dBm` : ''}`
        : `中枢没连上 Wi-Fi${net.portal ? `：用手机连热点「${net.portal}」配网` : ''}`;
  return (
    <section className="card" data-testid="iot-card">
      <div className="section-heading">
        <h2>家里的设备</h2>
        <span className="label">ESP32 当中枢 · 只走局域网</span>
      </div>
      <p className="muted" data-testid="iot-hub">
        {hubText}
      </p>
      {iot.config.devices.length === 0 ? (
        <p className="muted">
          还没登记设备。支持自带局域网接口的插座/开关：Tasmota、Shelly
          第二代、ESPHome。不经过云、不要账号。
        </p>
      ) : (
        <ul className="plain-list" data-testid="iot-list">
          {iot.config.devices.map((item) => {
            const shown = iotDisplay(iot, item.id, now);
            const live = iot.live.find((entry) => entry.id === item.id);
            const watts =
              shown === 'on' && live?.watts != null ? ` · ${live.watts.toFixed(1)}W` : '';
            return (
              <li key={item.id} className="toggle-row" data-testid={`iot-${item.id}`}>
                <span>
                  <strong>{item.name}</strong>
                  <span className={`label iot-${shown}`} data-testid={`iot-state-${item.id}`}>
                    {iotDisplayLabels[shown]}
                    {watts}
                  </span>
                  <br />
                  <small className="muted">
                    {iotKindLabels[item.kind]} · {item.host}
                    {item.channel ? ` · ${item.channel}` : ''}
                    {live?.error ? ` · ${live.error}` : ''}
                  </small>
                </span>
                <span className="inline-actions">
                  <button
                    type="button"
                    disabled={!iot.hub || shown === 'pending' || shown === 'offline'}
                    onClick={() => void toggle(item.id, shown !== 'on')}
                  >
                    {shown === 'on' ? '关掉' : '打开'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`删除 ${item.name}`}
                    onClick={() =>
                      void save(iot.config.devices.filter((entry) => entry.id !== item.id))
                    }
                  >
                    删除
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="input-row"
        onSubmit={async (event) => {
          event.preventDefault();
          if (await save([...iot.config.devices, form])) setForm(blankIotDevice);
        }}
      >
        <input
          aria-label="设备名字"
          placeholder="名字：台灯"
          value={form.name}
          maxLength={16}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
        />
        <select
          aria-label="设备类型"
          value={form.kind}
          onChange={(event) => setForm({ ...form, kind: event.target.value as IotKind })}
        >
          {iotKinds.map((kind) => (
            <option key={kind} value={kind}>
              {iotKindLabels[kind]}
            </option>
          ))}
        </select>
        <input
          aria-label="设备地址"
          placeholder="192.168.1.23"
          value={form.host}
          maxLength={60}
          onChange={(event) => setForm({ ...form, host: event.target.value })}
        />
        <input
          aria-label="通道"
          placeholder={
            form.kind === 'esphome' ? '实体 id：relay' : form.kind === 'shelly' ? '0' : '留空'
          }
          value={form.channel}
          maxLength={32}
          onChange={(event) => setForm({ ...form, channel: event.target.value })}
        />
        <button type="submit" disabled={busy || iot.config.devices.length >= iotLimits.maxDevices}>
          登记
        </button>
      </form>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <p className="muted">
        只接受局域网地址（192.168.x.x / 10.x / 172.16-31.x 或 xxx.local）。登记表会存进 ESP32，
        电脑关机时用它自己的按键也能开关。AI 对话里没有控制电源的能力。
      </p>
    </section>
  );
}

const statusText: Record<DeviceSnapshot['status'], string> = {
  off: '未启用',
  searching: '在找设备',
  handshake: '握手中',
  connected: '已连接',
  error: '出错了',
};

function DeviceCard({ device }: { device: DeviceSnapshot }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // 存盘要走一趟主进程：期间先显示用户刚选的值，否则开关点下去会「弹回来」一下。
  // 存失败就丢掉草稿，回到主进程里的真实值。
  const [draft, setDraft] = useState<DeviceConfig | null>(null);
  const config = draft ?? device.config;
  async function save(next: DeviceConfig) {
    setDraft(next);
    setSaving(true);
    setError('');
    try {
      const result = await window.companion!.deviceSave(next);
      if (!result.ok) setError(result.error ?? '没保存上。');
    } catch {
      setError('没保存上。');
    } finally {
      setDraft(null);
      setSaving(false);
    }
  }
  const view = device.lastView;
  const press = (button: 'A' | 'B') => ({
    onPointerDown: () => void window.companion!.deviceSimPress(button, 'down'),
    onPointerUp: () => void window.companion!.deviceSimPress(button, 'up'),
  });
  return (
    <section className="card" data-testid="device-card">
      <div className="section-heading">
        <h2>实体小屏</h2>
        <span className={`label device-${device.status}`} data-testid="device-status">
          {statusText[device.status]}
        </span>
      </div>
      <p className="muted">
        ESP32-S3 + 小屏 + 两个按键，用 USB 线插在电脑上。它显示的内容和桌宠小屏是同一份，
        按键也走同一套规则（A 允许/接、B 拒绝/知道了、B 长按勿扰）。协议与接线见
        docs/hardware-protocol.md。
      </p>
      <label className="toggle-row">
        <input
          type="checkbox"
          aria-label="启用实体设备"
          checked={config.enabled}
          disabled={saving}
          onChange={(event) => void save({ ...config, enabled: event.target.checked })}
        />
        <span>启用实体设备</span>
      </label>
      <div className="input-row">
        <select
          aria-label="连接方式"
          value={config.mode}
          disabled={saving}
          onChange={(event) =>
            void save({
              ...config,
              mode: event.target.value === 'simulated' ? 'simulated' : 'serial',
            })
          }
        >
          <option value="serial">USB 串口</option>
          <option value="simulated">模拟设备（没硬件时试协议）</option>
        </select>
        {config.mode === 'serial' && (
          <select
            aria-label="端口"
            value={config.port}
            disabled={saving}
            onChange={(event) => void save({ ...config, port: event.target.value })}
          >
            <option value="">自动找 ESP32</option>
            {device.ports.map((port) => (
              <option key={port.path} value={port.path}>
                {port.label}
                {port.likely ? ' ★' : ''}
              </option>
            ))}
          </select>
        )}
        <button onClick={() => void window.companion!.deviceRefresh()} disabled={saving}>
          刷新端口
        </button>
      </div>
      <p className="muted" data-testid="device-detail">
        {device.detail}
        {device.device
          ? ` · ${device.device.board ?? '未知板子'}${
              device.device.screen ? ` · ${device.device.screen.w}×${device.device.screen.h}` : ''
            }`
          : ''}
      </p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {view && (
        <div className="device-mirror" data-testid="device-mirror">
          <span className="label">设备上此刻显示</span>
          <b>
            {view.card
              ? view.card.kind === 'confirm'
                ? view.card.title
                : view.card.text
              : view.title}
          </b>
          <small>
            {view.card ? `A ${view.card.hintA} · B ${view.card.hintB}` : view.bubble || view.detail}
          </small>
        </div>
      )}
      {config.mode === 'simulated' && device.status === 'connected' && (
        <div className="inline-actions" data-testid="device-sim-buttons">
          <button {...press('A')}>模拟按 A</button>
          <button {...press('B')}>模拟按 B</button>
        </div>
      )}
      {device.logs.length > 0 && (
        <ul className="plain-list small">
          {device.logs.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
