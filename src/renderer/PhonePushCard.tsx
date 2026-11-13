import { useEffect, useState } from 'react';
import { phonePushLimits, type PhonePushView } from '../core/phone-push';
import { formatClock } from '../core/state';

/**
 * 离开电脑时推到手机：飞书群机器人。只推标题，不推命令、代码、对话；不能在手机上批准。
 * 地址只进不出：存好后面板只知道「配了」。
 */
export function PhonePushCard() {
  const [view, setView] = useState<PhonePushView | null>(null);
  const [webhook, setWebhook] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    window
      .companion!.phonePushState()
      .then((next) => {
        if (alive) setView(next);
      })
      .catch(() => {
        if (alive) setError('读不到推送设置。');
      });
    return () => {
      alive = false;
    };
  }, []);

  async function save(next: {
    enabled: boolean;
    idleMinutes: number;
    webhook?: string;
    secret?: string;
  }) {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const result = await window.companion!.phonePushSave(next);
      if (result.ok) {
        setView(result.view);
        setWebhook('');
        setSecret('');
        if (next.webhook !== undefined) setNote(next.webhook ? '地址存好了。' : '地址已清除。');
      } else setError(result.error);
    } catch {
      setError('没保存上，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const result = await window.companion!.phonePushTest();
      if (result.ok) setNote('发出去了，看看飞书群里有没有。');
      else setError(result.error ?? '没发出去。');
    } catch {
      setError('没发出去。');
    } finally {
      setBusy(false);
    }
  }

  const idle = view?.idleMinutes ?? phonePushLimits.defaultIdleMin;
  return (
    <section className="card" data-testid="phone-push-card">
      <div className="section-heading">
        <h2>推到手机</h2>
        <span className="label">飞书群机器人</span>
      </div>
      <p className="muted">
        电脑空闲超过设定时间、又有 Agent 等你或干完时，发一条到飞书群；同一会话 10 分钟内不重复。
        只发标题（「Claude Code 在 xinban
        项目等你批准」），不发命令原文、代码和对话；不能在手机上批准。 在飞书群里「设置 → 群机器人 →
        添加自定义机器人」拿地址，开了签名校验就把密钥也填上。
        配好地址后，聊天时说「发到飞书…」也能让芯伴发一条，发前会把原文给你确认（不受上面开关影响）。
      </p>
      {view && !view.encryption && (
        <p className="error-text">这台电脑的系统加密不可用，地址存不进去（不以明文保存）。</p>
      )}
      <label className="toggle-row">
        <span>离开时推到手机</span>
        <input
          type="checkbox"
          data-testid="phone-push-enabled"
          checked={view?.enabled ?? false}
          disabled={busy || !view?.configured}
          onChange={(event) => void save({ enabled: event.target.checked, idleMinutes: idle })}
        />
      </label>
      <label className="toggle-row">
        <span>空闲多久算离开</span>
        <select
          data-testid="phone-push-idle"
          value={idle}
          disabled={busy || view === null}
          onChange={(event) =>
            void save({ enabled: view?.enabled ?? false, idleMinutes: Number(event.target.value) })
          }
        >
          {phonePushLimits.idleChoicesMin.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes} 分钟
            </option>
          ))}
        </select>
      </label>
      <p className="muted" data-testid="phone-push-status">
        {view?.configured
          ? `已配好地址${view.signed ? '（带签名）' : ''}${view.lastSentAt ? ` · 上次发送 ${formatClock(view.lastSentAt)}` : ''}`
          : '还没填地址。'}
        {view?.lastError ? ` · 上次失败：${view.lastError}` : ''}
      </p>
      <form
        className="inline-actions"
        onSubmit={(event) => {
          event.preventDefault();
          void save({
            enabled: view?.enabled ?? false,
            idleMinutes: idle,
            webhook,
            ...(secret ? { secret } : {}),
          });
        }}
      >
        <input
          aria-label="飞书机器人地址"
          type="password"
          autoComplete="off"
          value={webhook}
          maxLength={300}
          placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
          onChange={(event) => setWebhook(event.target.value)}
        />
        <input
          aria-label="签名密钥"
          type="password"
          autoComplete="off"
          value={secret}
          maxLength={128}
          placeholder="签名密钥（可空）"
          onChange={(event) => setSecret(event.target.value)}
        />
        <button type="submit" disabled={busy || webhook.trim() === ''}>
          保存地址
        </button>
      </form>
      <div className="inline-actions">
        <button
          type="button"
          data-testid="phone-push-test"
          disabled={busy || !view?.configured}
          onClick={() => void test()}
        >
          发一条测试
        </button>
        {view?.configured && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void save({ enabled: false, idleMinutes: idle, webhook: '' })}
          >
            清除地址
          </button>
        )}
      </div>
      {note && (
        <p className="muted" role="status">
          {note}
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
