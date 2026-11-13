import { z } from 'zod';

/**
 * 物联网：由 ESP32 当中枢，控制同一 Wi-Fi 下的智能插座 / 开关，并实时回报状态。
 *
 * 分工（和屏幕协议一致的思路）：
 * - 电脑负责「配」和「看」：在面板里登记设备→ `iot.config` 下发；显示中枢报上来的状态；
 *   面板里点开关 → `iot.set`。
 * - ESP32 负责「做」：自己连 Wi-Fi、轮询设备、执行开关、把状态 `iot.state` 报上来；
 *   配置存在自己的 NVS 里，**电脑关机时照样能用实体按键控制**。
 *
 * 先支持三种自带「局域网公开接口」的设备：不经过云、不要账号、不要密钥。
 * - tasmota：刷了 Tasmota 的插座/开关（HTTP `/cm?cmnd=Power`）
 * - shelly：Shelly Plus/Pro 第二代（HTTP RPC `/rpc/Switch.GetStatus`）
 * - esphome：跑 ESPHome 且开了 web_server 的设备（REST `/switch/<id>`）
 *
 * 安全边界：只允许局域网地址（私有 IPv4 或 .local），中枢不会被配置去访问公网；
 * 电源开关只由用户的显式操作触发（面板按钮、实体按键），AI 对话里没有控制它的工具。
 */

export const iotKinds = ['tasmota', 'shelly', 'esphome'] as const;
export type IotKind = (typeof iotKinds)[number];

export const iotKindLabels: Record<IotKind, string> = {
  tasmota: 'Tasmota',
  shelly: 'Shelly 第二代',
  esphome: 'ESPHome',
};

export const iotLimits = {
  maxDevices: 8,
  nameChars: 16,
  /** 中枢多久没报某个设备的状态，就把它显示成「不确定」。 */
  staleMs: 20_000,
  /** 下发开关后多久没回执就不再显示「切换中」。 */
  pendingMs: 8_000,
} as const;

export interface IotDeviceConfig {
  /** 短 id，帧里用它指代设备。 */
  id: string;
  name: string;
  kind: IotKind;
  /** 局域网地址：192.168.1.23 或 plug-desk.local */
  host: string;
  /** 第几路：Tasmota 的 Power1..8、Shelly 的 switch id、ESPHome 的开关实体 id。 */
  channel: string;
}

export interface IotConfig {
  devices: IotDeviceConfig[];
}

export const defaultIotConfig: IotConfig = { devices: [] };

/** 私有 IPv4（10/8、172.16/12、192.168/16）或 mDNS 的 .local 主机名。 */
export function isLanHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number);
    if (parts.some((part) => part > 255)) return false;
    const [a, b] = parts as [number, number, number, number];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?\.local$/.test(value);
}

function channelOk(kind: IotKind, channel: string): boolean {
  if (kind === 'tasmota') return /^[1-8]?$/.test(channel);
  if (kind === 'shelly') return /^[0-3]$/.test(channel);
  return /^[a-z0-9_]{1,32}$/.test(channel);
}

export type IotCheck = { ok: true; value: IotDeviceConfig } | { ok: false; error: string };

/** 校验一台设备；返回的错误直接给面板显示。 */
export function checkIotDevice(raw: unknown): IotCheck {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: '设备信息不完整。' };
  const value = raw as Record<string, unknown>;
  const str = (key: string): string => (typeof value[key] === 'string' ? value[key].trim() : '');
  const kind = str('kind') as IotKind;
  if (!iotKinds.includes(kind))
    return { ok: false, error: '设备类型只能是 Tasmota / Shelly / ESPHome。' };
  const name = str('name').replace(/[\u0000-\u001f\u007f]/g, '');
  if (name === '' || [...name].length > iotLimits.nameChars) {
    return { ok: false, error: `名字不能为空，最多 ${iotLimits.nameChars} 个字。` };
  }
  const host = str('host').toLowerCase();
  if (!isLanHost(host)) {
    return { ok: false, error: '地址只能是局域网 IP（如 192.168.1.23）或 xxx.local。' };
  }
  const channel =
    str('channel').toLowerCase() || (kind === 'shelly' ? '0' : kind === 'esphome' ? 'relay' : '');
  if (!channelOk(kind, channel)) {
    return {
      ok: false,
      error:
        kind === 'tasmota'
          ? '通道留空或填 1~8。'
          : kind === 'shelly'
            ? '通道填 0~3。'
            : '通道填 ESPHome 开关的实体 id（小写字母、数字、下划线）。',
    };
  }
  const rawId = str('id');
  const id = /^[a-z0-9-]{1,16}$/.test(rawId) ? rawId : '';
  return { ok: true, value: { id, name, kind, host, channel } };
}

/** 整份配置：丢掉不合法的条目、补齐 id、去重、限量。 */
export function normalizeIotConfig(raw: unknown): IotConfig {
  const list =
    typeof raw === 'object' &&
    raw !== null &&
    Array.isArray((raw as Record<string, unknown>)['devices'])
      ? ((raw as Record<string, unknown>)['devices'] as unknown[])
      : [];
  const devices: IotDeviceConfig[] = [];
  const used = new Set<string>();
  for (const item of list) {
    if (devices.length >= iotLimits.maxDevices) break;
    const checked = checkIotDevice(item);
    if (!checked.ok) continue;
    let id = checked.value.id;
    if (id === '' || used.has(id)) {
      let n = devices.length + 1;
      while (used.has(`d${n}`)) n += 1;
      id = `d${n}`;
    }
    used.add(id);
    devices.push({ ...checked.value, id });
  }
  return { devices };
}

/* ---------------- 帧 ---------------- */

export const iotStateFrameSchema = z.object({
  t: z.literal('iot.state'),
  id: z.string().max(16),
  online: z.boolean(),
  on: z.boolean().optional(),
  /** 实时功率（瓦），有计量的设备才报。 */
  w: z.number().finite().min(0).max(100_000).optional(),
  err: z.string().max(80).optional(),
});

export const iotNetFrameSchema = z.object({
  t: z.literal('iot.net'),
  ok: z.boolean(),
  ssid: z.string().max(64).optional(),
  ip: z.string().max(40).optional(),
  rssi: z.number().int().min(-127).max(0).optional(),
  /** 没连上时中枢开的配网热点名。 */
  portal: z.string().max(32).optional(),
});

export type IotStateFrame = z.infer<typeof iotStateFrameSchema>;
export type IotNetFrame = z.infer<typeof iotNetFrameSchema>;

export type IotHostFrame =
  | {
      t: 'iot.config';
      devices: { id: string; name: string; kind: IotKind; host: string; ch: string }[];
    }
  | { t: 'iot.set'; id: string; on: boolean };

export function configFrame(config: IotConfig): IotHostFrame {
  return {
    t: 'iot.config',
    devices: config.devices.map((device) => ({
      id: device.id,
      name: device.name,
      kind: device.kind,
      host: device.host,
      ch: device.channel,
    })),
  };
}

/* ---------------- 实时状态 ---------------- */

export interface IotLive {
  id: string;
  online: boolean;
  on: boolean | null;
  watts: number | null;
  error: string;
  at: number;
  /** 面板刚发了开/关，还没等到回执。 */
  pending: boolean;
  pendingAt: number;
}

export interface IotState {
  config: IotConfig;
  /** 已连上的设备在 hello 里声明了 iot 能力。 */
  hub: boolean;
  net: { ok: boolean; ssid: string; ip: string; rssi: number | null; portal: string } | null;
  live: IotLive[];
}

export const emptyIotState = (): IotState => ({
  config: defaultIotConfig,
  hub: false,
  net: null,
  live: [],
});

export function applyStateFrame(
  live: readonly IotLive[],
  frame: IotStateFrame,
  now: number,
): IotLive[] {
  const next: IotLive = {
    id: frame.id,
    online: frame.online,
    on: frame.online ? (frame.on ?? null) : null,
    watts: frame.online ? (frame.w ?? null) : null,
    error: frame.err ?? '',
    at: now,
    pending: false,
    pendingAt: 0,
  };
  return [...live.filter((item) => item.id !== frame.id), next];
}

export function markPending(live: readonly IotLive[], id: string, now: number): IotLive[] {
  const current = live.find((item) => item.id === id);
  const base: IotLive = current ?? {
    id,
    online: false,
    on: null,
    watts: null,
    error: '',
    at: 0,
    pending: false,
    pendingAt: 0,
  };
  return [...live.filter((item) => item.id !== id), { ...base, pending: true, pendingAt: now }];
}

export type IotDisplay = 'on' | 'off' | 'offline' | 'unknown' | 'pending';

/** 面板上这一行该显示什么。没有中枢、状态过旧都算「不确定」，绝不拿旧值充当现在。 */
export function iotDisplay(state: IotState, id: string, now: number): IotDisplay {
  const live = state.live.find((item) => item.id === id);
  if (!state.hub || !live) return 'unknown';
  if (live.pending && now - live.pendingAt < iotLimits.pendingMs) return 'pending';
  if (live.at === 0 || now - live.at > iotLimits.staleMs) return 'unknown';
  if (!live.online) return 'offline';
  if (live.on === null) return 'unknown';
  return live.on ? 'on' : 'off';
}

export const iotDisplayLabels: Record<IotDisplay, string> = {
  on: '开着',
  off: '关着',
  offline: '连不上',
  unknown: '不确定',
  pending: '切换中…',
};
