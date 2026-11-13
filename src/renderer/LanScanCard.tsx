import { useEffect, useState } from 'react';
import type { DeviceSnapshot } from '../core/device-protocol';
import { iotKindLabels, iotLimits } from '../core/iot';
import {
  lanCategories,
  lanCategoryLabels,
  type LanCategory,
  type LanDevice,
  type LanScanState,
} from '../core/lan-scan';
import { formatClock } from '../core/state';

const highlight: readonly LanCategory[] = ['hub-ready', 'flashable', 'lan-api', 'media'];

/**
 * 家庭设备普查：点一下扫一遍局域网，列出家里的设备和「各自能玩什么」。
 * 能直接接中枢的（Tasmota / Shelly / ESPHome）一键登记到「家里的设备」。
 */
export function LanScanCard({ device }: { device: DeviceSnapshot }) {
  const [state, setState] = useState<LanScanState | null>(null);
  const [subnet, setSubnet] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    let alive = true;
    void window
      .companion!.lanScanState()
      .then((next) => {
        if (alive) setState(next);
      })
      .catch(() => undefined);
    const off = window.companion!.onLanScan((next) => setState(next));
    return () => {
      alive = false;
      off();
    };
  }, []);
  if (!state) return null;

  async function start() {
    setError('');
    setNote('');
    try {
      const result = await window.companion!.lanScanStart(subnet);
      if (!result.ok) setError(result.error);
    } catch {
      setError('没开始扫，请重试。');
    }
  }

  const registered = new Set(device.iot.config.devices.map((item) => item.host));
  async function register(item: LanDevice) {
    if (!item.iot) return;
    setError('');
    setNote('');
    const name = (item.name || iotKindLabels[item.iot.kind]).replace(/[\u0000-\u001f\u007f]/g, '');
    try {
      const result = await window.companion!.iotSave({
        devices: [
          ...device.iot.config.devices,
          {
            id: '',
            name: [...name].slice(0, iotLimits.nameChars).join(''),
            kind: item.iot.kind,
            host: item.ip,
            channel: item.iot.channel,
          },
        ],
      });
      if (result.ok) setNote(`已登记 ${item.ip}，在下面「家里的设备」里看。`);
      else setError(result.error ?? '没登记上。');
    } catch {
      setError('没登记上。');
    }
  }

  const last = state.last;
  const devices = last?.devices ?? [];
  const counts = new Map<LanCategory, number>();
  for (const item of devices) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  const shown = showAll ? devices : devices.filter((item) => highlight.includes(item.category));
  const hidden = devices.length - shown.length;
  const current = subnet || state.subnets[0]?.key || '';

  return (
    <section className="card" data-testid="lan-scan-card">
      <div className="section-heading">
        <h2>家庭设备普查</h2>
        <span className="label">只读 · 只扫本机所在的局域网</span>
      </div>
      <p className="muted">
        看看家里连着 Wi-Fi / 网线的设备都有什么、哪些能直接玩。只问一声：敲常见端口、广播问谁在、
        读开着的网页首页，不发控制命令、不登录。结果只存本机，不发给 AI。第一次扫 Windows
        可能问要不要让芯伴访问网络，选「专用网络」即可。蓝牙和红外设备不在网里，这里扫不到。
      </p>
      <p className="error-text">
        只在自己家里的网络用。公司、学校、咖啡店的网络别扫：可能违反规定、触发安全告警。
      </p>
      <div className="input-row">
        {state.subnets.length > 1 && (
          <select
            aria-label="扫哪个网段"
            value={current}
            disabled={state.running}
            onChange={(event) => setSubnet(event.target.value)}
          >
            {state.subnets.map((item) => (
              <option key={item.key} value={item.key}>
                {item.key} · {item.name}
                {item.virtual ? '（像虚拟网卡）' : ''}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className="primary"
          data-testid="lan-scan-start"
          disabled={state.running || state.subnets.length === 0}
          onClick={() => void start()}
        >
          {state.running ? '正在扫…' : last ? '重新扫一遍' : '开始普查'}
        </button>
        <small className="muted" data-testid="lan-scan-progress">
          {state.running
            ? state.progress
            : state.subnets.length === 0
              ? '没找到家庭局域网的地址。'
              : state.subnets.length === 1
                ? `会扫 ${current}（${state.subnets[0]!.name}），大约半分钟。`
                : '大约半分钟。'}
        </small>
      </div>
      {(error || state.error) && (
        <p className="error-text" role="alert">
          {error || state.error}
        </p>
      )}
      {note && (
        <p className="muted" role="status">
          {note}
        </p>
      )}
      {last && (
        <>
          <p className="muted" data-testid="lan-scan-summary">
            {formatClock(last.at)} 扫了 {last.subnet}，用时 {Math.round(last.durationMs / 1_000)}{' '}
            秒，找到 {devices.length} 台：
            {lanCategories
              .filter((category) => counts.has(category))
              .map((category) => `${lanCategoryLabels[category]} ${counts.get(category)}`)
              .join(' · ')}
          </p>
          {last.notes.map((item) => (
            <p className="muted" key={item}>
              {item}
            </p>
          ))}
          {shown.length === 0 ? (
            <div className="empty-state">
              没发现能直接玩的设备。家里的家电多半不联网，红外和蓝牙要等板子到了再试。
            </div>
          ) : (
            <ul className="plain-list" data-testid="lan-scan-list">
              {shown.map((item) => (
                <li key={item.ip} data-testid={`lan-${item.ip}`}>
                  <span>
                    <strong>{item.name || item.ip}</strong>
                    <span className={`label lan-${item.category}`}>
                      {lanCategoryLabels[item.category]}
                    </span>
                    <br />
                    <small>{item.hint}</small>
                    <br />
                    <small className="muted">
                      {item.ip}
                      {item.mac ? ` · ${item.mac}` : ''}
                      {item.model ? ` · ${item.model}` : ''}
                      {item.evidence.length > 0 ? ` · ${item.evidence.join('；')}` : ''}
                    </small>
                  </span>
                  {item.iot && (
                    <button
                      type="button"
                      disabled={
                        registered.has(item.ip) ||
                        device.iot.config.devices.length >= iotLimits.maxDevices
                      }
                      onClick={() => void register(item)}
                    >
                      {registered.has(item.ip) ? '已登记' : '登记到家里的设备'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {(hidden > 0 || showAll) && (
            <button type="button" className="link-button" onClick={() => setShowAll(!showAll)}>
              {showAll
                ? '只看能玩的'
                : `还有 ${hidden} 台（路由器、电脑、手机、认不出的），全部展开`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
