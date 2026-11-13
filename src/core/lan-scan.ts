import type { IotKind } from './iot';

/**
 * 家庭设备普查：只读扫一遍局域网，看看家里有哪些设备、哪些能直接玩。
 *
 * 边界（代码里的门，不是嘱咐）：
 * - 只扫本机所在的私有网段，最多一个 /24（254 台）；更大的网段只扫本机附近那 /24。
 * - 只做「问一声」：TCP 握手看端口开没开、mDNS / SSDP 广播问谁在、对开着网页的设备 GET 首页和
 *   设备描述。不发任何控制命令，不登录，不猜密码。
 * - 只有面板按钮能发起；结果只存本机，不进 AI 对话。
 *
 * 这个文件只放纯函数（网段计算、解析、识别），收发包在 desktop/lan-scan.ts。
 */

export const lanScanLimits = {
  maxHosts: 254,
  /** 单个端口握手等多久。局域网里通的设备几毫秒就回。 */
  probeTimeoutMs: 700,
  httpTimeoutMs: 1_500,
  /** mDNS / SSDP 广播后等回复的时间。 */
  listenMs: 3_000,
  httpBodyBytes: 64 * 1024,
  concurrency: 64,
  maxDevices: 254,
} as const;

/** 每台在线设备都会敲一下的端口：几乎都是「家里设备」常见的局域网接口。 */
export const probePorts = [
  22, 53, 80, 443, 445, 554, 1400, 1883, 3389, 5555, 6053, 6668, 7000, 8001, 8008, 8009, 8080, 8443,
  9100, 9999, 55443, 62078,
] as const;

export const portLabels: Record<number, string> = {
  22: 'SSH',
  53: 'DNS',
  80: '网页',
  443: 'HTTPS',
  445: '文件共享',
  554: 'RTSP 视频流',
  1400: 'Sonos',
  1883: 'MQTT',
  3389: '远程桌面',
  5555: '安卓调试口',
  6053: 'ESPHome 接口',
  6668: '涂鸦局域网',
  7000: 'AirPlay',
  8001: '三星电视接口',
  8008: '投屏',
  8009: '投屏',
  8080: '网页 8080',
  8443: 'HTTPS 8443',
  9100: '打印',
  9999: 'TP-Link 局域网',
  55443: 'Yeelight 局域网',
  62078: 'iPhone/iPad 同步',
};

/** 主动问的 mDNS 服务（再加上「有哪些服务」的总目录）。 */
export const mdnsServices: Record<string, string> = {
  '_esphomelib._tcp': 'ESPHome',
  '_wled._tcp': 'WLED 灯效',
  '_shelly._tcp': 'Shelly',
  '_hap._tcp': 'HomeKit 配件',
  '_matter._tcp': 'Matter',
  '_matterc._udp': 'Matter（待配网）',
  '_miio._udp': '小米 miIO',
  '_googlecast._tcp': 'Chromecast 投屏',
  '_androidtvremote2._tcp': 'Android TV',
  '_airplay._tcp': 'AirPlay',
  '_raop._tcp': 'AirPlay 音频',
  '_spotify-connect._tcp': 'Spotify Connect',
  '_hue._tcp': '飞利浦 Hue',
  '_ipp._tcp': '打印机',
  '_printer._tcp': '打印机',
  '_pdl-datastream._tcp': '打印机',
  '_mqtt._tcp': 'MQTT',
  '_home-assistant._tcp': 'Home Assistant',
  '_arduino._tcp': 'Arduino OTA',
  '_http._tcp': '网页',
  '_smb._tcp': '文件共享',
  '_workstation._tcp': '电脑',
  '_companion-link._tcp': '苹果设备',
  '_sleep-proxy._udp': '苹果休眠代理',
};

/* ---------------- 网段 ---------------- */

export interface NetInterfaceInfo {
  address: string;
  netmask: string;
  family: string | number;
  internal: boolean;
}

export interface LanSubnet {
  /** 「192.168.1.0/24」——面板和 IPC 都用它当 key。 */
  key: string;
  name: string;
  /** 本机在这个网段的地址。 */
  address: string;
  base: string;
  prefix: number;
  /** 网卡掩码比 /24 宽，只扫了本机附近的 /24。 */
  narrowed: boolean;
  /** 名字像虚拟网卡（WSL、Hyper-V、VMware、VPN…）。 */
  virtual: boolean;
}

export function ipToInt(ip: string): number | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return null;
  return (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
}

export function intToIp(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

function prefixOf(netmask: string): number | null {
  const mask = ipToInt(netmask);
  if (mask === null) return null;
  const bits = mask.toString(2).padStart(32, '0');
  return /^1*0*$/.test(bits) ? (bits.indexOf('0') === -1 ? 32 : bits.indexOf('0')) : null;
}

export function isPrivateIpv4(ip: string): boolean {
  const value = ipToInt(ip);
  if (value === null) return false;
  const a = value >>> 24;
  const b = (value >>> 16) & 255;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

const virtualName =
  /vethernet|vmware|virtualbox|vbox|hyper-v|wsl|docker|loopback|tailscale|zerotier|vpn|tap|tun|npcap|bluetooth|蓝牙|radmin|hamachi|clash|wintun/i;

function rank(subnet: LanSubnet): number {
  const first = Number(subnet.base.split('.')[0]);
  return (subnet.virtual ? 10 : 0) + (first === 192 ? 0 : first === 10 ? 1 : 2);
}

/** 从 os.networkInterfaces() 挑出能扫的私有网段，最像家里 Wi-Fi 的排第一。 */
export function lanSubnets(
  interfaces: Record<string, readonly NetInterfaceInfo[] | undefined>,
): LanSubnet[] {
  const list: LanSubnet[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family !== 'IPv4' && entry.family !== 4) continue;
      if (!isPrivateIpv4(entry.address)) continue;
      const address = ipToInt(entry.address);
      const real = prefixOf(entry.netmask);
      if (address === null || real === null || real > 30) continue;
      const prefix = Math.max(real, 24);
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      const base = intToIp((address & mask) >>> 0);
      const key = `${base}/${prefix}`;
      if (list.some((item) => item.key === key)) continue;
      list.push({
        key,
        name,
        address: entry.address,
        base,
        prefix,
        narrowed: real < 24,
        virtual: virtualName.test(name),
      });
    }
  }
  return list.sort((a, b) => rank(a) - rank(b));
}

/** 网段里所有可用主机地址（去掉网络号和广播）。 */
export function subnetHosts(subnet: Pick<LanSubnet, 'base' | 'prefix'>): string[] {
  const base = ipToInt(subnet.base);
  if (base === null || subnet.prefix < 24 || subnet.prefix > 30) return [];
  const size = 2 ** (32 - subnet.prefix);
  const hosts: string[] = [];
  for (let offset = 1; offset < size - 1; offset += 1) hosts.push(intToIp(base + offset));
  return hosts.slice(0, lanScanLimits.maxHosts);
}

export function inSubnet(ip: string, subnet: Pick<LanSubnet, 'base' | 'prefix'>): boolean {
  const value = ipToInt(ip);
  const base = ipToInt(subnet.base);
  if (value === null || base === null) return false;
  const mask = (0xffffffff << (32 - subnet.prefix)) >>> 0;
  const host = (value & ~mask) >>> 0;
  return (value & mask) >>> 0 === base && host !== 0 && host !== ~mask >>> 0;
}

/* ---------------- 邻居表（arp -a / ip neigh） ---------------- */

export interface Neighbor {
  ip: string;
  mac: string;
}

export function normalizeMac(raw: string): string | null {
  const hex = raw.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  return hex.match(/../g)!.join(':');
}

/**
 * 解析 Windows `arp -a` 和 Linux `ip neigh`。只认「IP + MAC」这一对，表头（中文系统是 GBK 汉字）、
 * 类型列一律不看；广播、组播、全零地址丢掉。
 */
export function parseNeighbors(text: string): Neighbor[] {
  const found = new Map<string, string>();
  const pattern =
    /(\d{1,3}(?:\.\d{1,3}){3})\s+(?:dev\s+\S+\s+lladdr\s+)?([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5})/gi;
  for (const match of text.matchAll(pattern)) {
    const ip = match[1]!;
    const mac = normalizeMac(match[2]!);
    if (mac === null || ipToInt(ip) === null) continue;
    const first = parseInt(mac.slice(0, 2), 16);
    if (mac === 'ff:ff:ff:ff:ff:ff' || mac === '00:00:00:00:00:00' || (first & 1) === 1) continue;
    if (ipToInt(ip)! >>> 28 >= 14) continue;
    found.set(ip, mac);
  }
  return [...found.entries()].map(([ip, mac]) => ({ ip, mac }));
}

/* ---------------- MAC 厂商 ---------------- */

/** 只收和「家里能玩的硬件」最相关的几家；认不出的就是认不出，不瞎猜。 */
const ouiVendors: Record<string, string> = {};
for (const oui of [
  '18fe34',
  '5ccf7f',
  '600194',
  '240ac4',
  '30aea4',
  '84f3eb',
  'a4cf12',
  '246f28',
  'bcddc2',
  'dc4f22',
  '84cca8',
  '7c9ebd',
  '8caab5',
  'c82b96',
  'ecfabc',
  '3c71bf',
  '68c63a',
  '2cf432',
  '483fda',
  '58bf25',
  '94b97e',
  '98f4ab',
  '40f520',
  '10521c',
  'e868e7',
  '083af2',
  '349454',
  '3c6105',
  'c44f33',
  '4c11ae',
  '348518',
  '4827e2',
  '7cdfa1',
  'f412fa',
  '84f703',
  '543204',
  'a0764e',
  '404cca',
  'ecda3b',
  '70041d',
  'b4e62d',
  '30c6f7',
  '78e36d',
  '34b472',
  '2462ab',
  'cc50e3',
  'e09806',
  '9c9c1f',
  '24dcc3',
  'c049ef',
  'f008d1',
]) {
  ouiVendors[oui] = 'Espressif（ESP 芯片）';
}
for (const oui of ['b827eb', 'dca632', 'e45f01', 'd83add', '28cdc1', '2ccf67']) {
  ouiVendors[oui] = '树莓派';
}

export interface MacInfo {
  vendor: string | null;
  /** 本地管理位为 1：手机、新版 Windows 的「随机硬件地址」。 */
  random: boolean;
  espressif: boolean;
}

export function macInfo(mac: string | null | undefined): MacInfo {
  const value = mac ? normalizeMac(mac) : null;
  if (!value) return { vendor: null, random: false, espressif: false };
  const random = (parseInt(value.slice(0, 2), 16) & 2) === 2;
  const vendor = random ? null : (ouiVendors[value.replace(/:/g, '').slice(0, 6)] ?? null);
  return { vendor, random, espressif: vendor?.startsWith('Espressif') ?? false };
}

/* ---------------- mDNS（DNS 报文） ---------------- */

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;

export const mdnsAddress = '224.0.0.251';
export const mdnsPort = 5353;

function encodeName(name: string): Buffer {
  const parts = name
    .replace(/\.$/, '')
    .split('.')
    .map((label) => {
      const bytes = Buffer.from(label, 'utf8');
      return Buffer.concat([Buffer.from([bytes.length]), bytes]);
    });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

/** 一个查询包：问总目录 + 关心的服务类型，PTR，要求单播回复（QU）。 */
export function mdnsQuery(): Buffer {
  const names = [
    '_services._dns-sd._udp.local',
    ...Object.keys(mdnsServices).map((s) => `${s}.local`),
  ];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(names.length, 4);
  const questions = names.map((name) => {
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(TYPE_PTR, 0);
    tail.writeUInt16BE(0x8001, 2);
    return Buffer.concat([encodeName(name), tail]);
  });
  return Buffer.concat([header, ...questions]);
}

export interface DnsRecord {
  name: string;
  type: number;
  /** PTR / SRV 的目标名。 */
  target?: string;
  port?: number;
  address?: string;
  txt?: string[];
}

function readName(buf: Buffer, start: number): { name: string; next: number } | null {
  const labels: string[] = [];
  let offset = start;
  let next = -1;
  for (let jumps = 0; jumps < 32; jumps += 1) {
    if (offset >= buf.length) return null;
    const length = buf[offset]!;
    if (length === 0) {
      return { name: labels.join('.'), next: next === -1 ? offset + 1 : next };
    }
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= buf.length) return null;
      if (next === -1) next = offset + 2;
      offset = ((length & 0x3f) << 8) | buf[offset + 1]!;
      continue;
    }
    if (offset + 1 + length > buf.length) return null;
    labels.push(buf.toString('utf8', offset + 1, offset + 1 + length));
    offset += 1 + length;
  }
  return null;
}

/** 解析一个 mDNS 回复包；查询包（别人在问）和坏包返回空数组。 */
export function parseDnsPacket(buf: Buffer): DnsRecord[] {
  if (buf.length < 12) return [];
  if ((buf.readUInt16BE(2) & 0x8000) === 0) return [];
  const qd = buf.readUInt16BE(4);
  const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let offset = 12;
  for (let i = 0; i < qd; i += 1) {
    const name = readName(buf, offset);
    if (!name) return [];
    offset = name.next + 4;
  }
  const records: DnsRecord[] = [];
  for (let i = 0; i < total && i < 200; i += 1) {
    const name = readName(buf, offset);
    if (!name || name.next + 10 > buf.length) break;
    const type = buf.readUInt16BE(name.next);
    const length = buf.readUInt16BE(name.next + 8);
    const data = name.next + 10;
    if (data + length > buf.length) break;
    const record: DnsRecord = { name: name.name, type };
    if (type === TYPE_PTR) record.target = readName(buf, data)?.name;
    else if (type === TYPE_SRV && length >= 7) {
      record.port = buf.readUInt16BE(data + 4);
      record.target = readName(buf, data + 6)?.name;
    } else if (type === TYPE_A && length === 4) {
      record.address = [...buf.subarray(data, data + 4)].join('.');
    } else if (type === TYPE_TXT) {
      const txt: string[] = [];
      let cursor = data;
      while (cursor < data + length) {
        const size = buf[cursor]!;
        txt.push(buf.toString('utf8', cursor + 1, Math.min(cursor + 1 + size, data + length)));
        cursor += 1 + size;
      }
      record.txt = txt;
    }
    records.push(record);
    offset = data + length;
  }
  return records;
}

export interface MdnsInfo {
  /** 服务类型，如 `_googlecast._tcp`。 */
  services: string[];
  /** 实例名（常常就是用户起的名字：「客厅电视」）。 */
  names: string[];
  hostname?: string;
  txt: Record<string, string>;
}

const txtKeys = new Set([
  'fn',
  'md',
  'model',
  'manufacturer',
  'ty',
  'am',
  'version',
  'friendly_name',
  'mac',
  'project_name',
  'board',
  'platform',
  'app',
  'gen',
]);

function serviceType(name: string): string | null {
  const match = /(_[a-z0-9-]+\._(?:tcp|udp))\.local$/i.exec(name);
  return match ? match[1]!.toLowerCase() : null;
}

/** 一个回复包 → 按 IP 归好的服务信息。A 记录能对上就用它，对不上就算发包的那台。 */
export function mdnsByHost(records: readonly DnsRecord[], source: string): Map<string, MdnsInfo> {
  const addressOf = new Map<string, string>();
  for (const record of records) {
    if (record.type === TYPE_A && record.address)
      addressOf.set(record.name.toLowerCase(), record.address);
  }
  const srvOf = new Map<string, string>();
  for (const record of records) {
    if (record.type === TYPE_SRV && record.target)
      srvOf.set(record.name.toLowerCase(), record.target);
  }
  const result = new Map<string, MdnsInfo>();
  const info = (ip: string): MdnsInfo => {
    let item = result.get(ip);
    if (!item) {
      item = { services: [], names: [], txt: {} };
      result.set(ip, item);
    }
    return item;
  };
  const hostOf = (instance: string): { ip: string; host?: string } => {
    const host = srvOf.get(instance.toLowerCase());
    const ip = host ? addressOf.get(host.toLowerCase()) : undefined;
    return { ip: ip ?? source, host };
  };
  for (const record of records) {
    if (record.type === TYPE_PTR && record.target) {
      if (record.name.toLowerCase() === '_services._dns-sd._udp.local') {
        const type = serviceType(record.target);
        if (type) {
          const item = info(source);
          if (!item.services.includes(type)) item.services.push(type);
        }
        continue;
      }
      const type = serviceType(record.name);
      if (!type) continue;
      const where = hostOf(record.target);
      const item = info(where.ip);
      if (!item.services.includes(type)) item.services.push(type);
      const label = record.target.slice(0, record.target.length - record.name.length - 1);
      if (label && !item.names.includes(label)) item.names.push(label.slice(0, 60));
      if (where.host && !item.hostname) item.hostname = where.host.replace(/\.local$/i, '');
    } else if (record.type === TYPE_TXT && record.txt && serviceType(record.name)) {
      const item = info(hostOf(record.name).ip);
      for (const entry of record.txt) {
        const eq = entry.indexOf('=');
        if (eq <= 0) continue;
        const key = entry.slice(0, eq).toLowerCase();
        const value = entry.slice(eq + 1).trim();
        if (txtKeys.has(key) && value && !(key in item.txt)) item.txt[key] = value.slice(0, 64);
      }
    }
  }
  return result;
}

export function mergeMdns(a: MdnsInfo | undefined, b: MdnsInfo): MdnsInfo {
  if (!a) return b;
  return {
    services: [...new Set([...a.services, ...b.services])],
    names: [...new Set([...a.names, ...b.names])].slice(0, 6),
    hostname: a.hostname ?? b.hostname,
    txt: { ...b.txt, ...a.txt },
  };
}

/* ---------------- SSDP / UPnP ---------------- */

export const ssdpAddress = '239.255.255.250';
export const ssdpPort = 1900;

export function ssdpSearch(): Buffer {
  return Buffer.from(
    'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n',
  );
}

export interface SsdpInfo {
  server?: string;
  location?: string;
  types: string[];
  friendlyName?: string;
  manufacturer?: string;
  model?: string;
}

export function parseSsdpResponse(
  text: string,
): { server?: string; location?: string; st?: string } | null {
  if (!/^HTTP\/1\.[01] 200/i.test(text) && !/^NOTIFY /i.test(text)) return null;
  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0)
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return {
    server: headers['server']?.slice(0, 120),
    location: headers['location']?.slice(0, 300),
    st: (headers['st'] ?? headers['nt'])?.slice(0, 120),
  };
}

/** 设备描述 XML 里挑几个字段；只认第一台（根设备）。 */
export function parseUpnpDescription(
  xml: string,
): Pick<SsdpInfo, 'friendlyName' | 'manufacturer' | 'model'> {
  const pick = (tag: string): string | undefined => {
    const match = new RegExp(`<${tag}>([^<]{1,120})</${tag}>`, 'i').exec(xml);
    return match ? decodeXml(match[1]!.trim()) || undefined : undefined;
  };
  return {
    friendlyName: pick('friendlyName'),
    manufacturer: pick('manufacturer'),
    model: pick('modelName') ?? pick('modelDescription'),
  };
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** SSDP 给的描述地址只在「就是发包那台、局域网、http」时才去取，别被引到别处。 */
export function safeLocation(location: string | undefined, source: string): string | null {
  if (!location) return null;
  try {
    const url = new URL(location);
    if (url.protocol !== 'http:' || url.hostname !== source || !isPrivateIpv4(source)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/* ---------------- 网页指纹 ---------------- */

export interface HttpInfo {
  server?: string;
  title?: string;
  tasmota: boolean;
  esphome: boolean;
  wled: boolean;
  /** GET /shelly 的回答：第几代、型号。 */
  shelly?: { gen: number; model?: string };
}

export function parseHttpHome(
  headers: Record<string, string | string[] | undefined>,
  body: string,
): HttpInfo {
  const server = typeof headers['server'] === 'string' ? headers['server'].slice(0, 80) : undefined;
  const titleMatch = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(body);
  const title = titleMatch ? decodeXml(titleMatch[1]!.trim()) || undefined : undefined;
  const all = `${server ?? ''} ${title ?? ''} ${body.slice(0, 20_000)}`;
  return {
    server,
    title,
    tasmota: /tasmota/i.test(all),
    esphome: /esphome/i.test(all),
    wled: /\bwled\b/i.test(`${title ?? ''} ${server ?? ''}`),
  };
}

/** `/shelly` 的 JSON：二代起有 gen 字段，一代只有 type。 */
export function parseShelly(body: string): HttpInfo['shelly'] | undefined {
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    if (typeof value !== 'object' || value === null) return undefined;
    if (typeof value['gen'] === 'number') {
      const model =
        typeof value['model'] === 'string'
          ? value['model']
          : typeof value['app'] === 'string'
            ? value['app']
            : undefined;
      return { gen: value['gen'], model };
    }
    if (typeof value['type'] === 'string' && /^SH/i.test(value['type']))
      return { gen: 1, model: value['type'] };
  } catch {
    // 不是 JSON：不是 Shelly。
  }
  return undefined;
}

/* ---------------- 识别 ---------------- */

export const lanCategories = [
  'hub-ready',
  'flashable',
  'lan-api',
  'media',
  'camera',
  'printer',
  'router',
  'computer',
  'phone',
  'unknown',
] as const;
export type LanCategory = (typeof lanCategories)[number];

export const lanCategoryLabels: Record<LanCategory, string> = {
  'hub-ready': '能直接接中枢',
  flashable: 'ESP 芯片',
  'lan-api': '有局域网接口',
  media: '电视 / 音箱',
  camera: '摄像头',
  printer: '打印机',
  router: '路由器',
  computer: '电脑',
  phone: '手机 / 平板',
  unknown: '认不出',
};

export interface LanHostRaw {
  ip: string;
  mac?: string;
  hostname?: string;
  ports: number[];
  mdns?: MdnsInfo;
  ssdp?: SsdpInfo;
  http?: HttpInfo;
  self?: boolean;
}

export interface LanDevice {
  ip: string;
  mac: string | null;
  name: string;
  model: string;
  category: LanCategory;
  /** 这台能玩什么——一句话。 */
  hint: string;
  /** 凭什么这么判断：厂商、端口、广播里的服务。 */
  evidence: string[];
  /** 能直接登记到「家里的设备」的，带上类型和默认通道。 */
  iot: { kind: IotKind; channel: string } | null;
  self: boolean;
}

function has(raw: LanHostRaw, ...services: string[]): boolean {
  return services.some((service) => raw.mdns?.services.includes(service) ?? false);
}

function port(raw: LanHostRaw, ...ports: number[]): boolean {
  return ports.some((value) => raw.ports.includes(value));
}

export function classifyHost(raw: LanHostRaw): LanDevice {
  const mac = raw.mac ? normalizeMac(raw.mac) : null;
  const info = macInfo(mac);
  const txt = raw.mdns?.txt ?? {};
  const evidence: string[] = [];
  if (info.vendor) evidence.push(`MAC 厂商：${info.vendor}`);
  if (info.random) evidence.push('随机 MAC（手机或电脑的隐私地址）');
  if (raw.ports.length > 0) {
    evidence.push(
      `开放端口：${[...raw.ports]
        .sort((a, b) => a - b)
        .map((value) => (portLabels[value] ? `${value} ${portLabels[value]}` : String(value)))
        .join('、')}`,
    );
  }
  if (raw.mdns && raw.mdns.services.length > 0) {
    evidence.push(
      `广播的服务：${raw.mdns.services.map((service) => mdnsServices[service] ?? service).join('、')}`,
    );
  }
  if (raw.ssdp) {
    const upnp =
      [raw.ssdp.manufacturer, raw.ssdp.model].filter(Boolean).join(' ') || raw.ssdp.server;
    if (upnp) evidence.push(`UPnP：${upnp}`);
  }
  if (raw.http?.title || raw.http?.server) {
    evidence.push(`网页：${[raw.http.title, raw.http.server].filter(Boolean).join(' · ')}`);
  }

  const title = raw.http?.title && !genericTitle.test(raw.http.title) ? raw.http.title : undefined;
  const name =
    (raw.self ? '这台电脑' : '') ||
    txt['fn'] ||
    txt['friendly_name'] ||
    raw.ssdp?.friendlyName ||
    raw.mdns?.names[0] ||
    title ||
    raw.hostname ||
    raw.mdns?.hostname ||
    '';
  const model =
    txt['md'] ||
    txt['model'] ||
    txt['am'] ||
    raw.http?.shelly?.model ||
    [raw.ssdp?.manufacturer, raw.ssdp?.model].filter(Boolean).join(' ') ||
    (txt['project_name'] ?? '') ||
    '';
  const text = [name, model, raw.ssdp?.server, raw.http?.server, raw.http?.title]
    .join(' ')
    .toLowerCase();
  // 电脑 / NAS 的特征：有它们就不凭单个端口猜成电视、摄像头、涂鸦设备。
  const pcLike =
    port(raw, 445, 3389) ||
    has(
      raw,
      '_workstation._tcp',
      '_smb._tcp',
      '_ssh._tcp',
      '_sftp-ssh._tcp',
      '_rfb._tcp',
      '_afpovertcp._tcp',
      '_adisk._tcp',
    );

  const out = (category: LanCategory, hint: string, iot: LanDevice['iot'] = null): LanDevice => ({
    ip: raw.ip,
    mac,
    name: name.slice(0, 60),
    model: model.slice(0, 60),
    category,
    hint,
    evidence,
    iot,
    self: raw.self ?? false,
  });

  if (raw.self) return out('computer', '芯伴正在这台电脑上运行。');
  if (raw.http?.tasmota) {
    return out('hub-ready', '刷了 Tasmota：自带局域网开关接口，能直接登记到「家里的设备」。', {
      kind: 'tasmota',
      channel: '',
    });
  }
  if (raw.http?.shelly && raw.http.shelly.gen >= 2) {
    return out('hub-ready', 'Shelly 第二代：自带局域网接口，能直接登记到「家里的设备」。', {
      kind: 'shelly',
      channel: '0',
    });
  }
  if (has(raw, '_esphomelib._tcp') || (raw.http?.esphome ?? false)) {
    const web = port(raw, 80);
    return out(
      'hub-ready',
      web
        ? 'ESPHome 设备：开了网页接口，能登记到「家里的设备」（通道填开关的实体 id）。'
        : 'ESPHome 设备：没开 web_server，中枢暂时连不上；在它的配置里加 web_server 就行。',
      web ? { kind: 'esphome', channel: 'relay' } : null,
    );
  }
  if (raw.http?.shelly) {
    return out('lan-api', '第一代 Shelly：有局域网 HTTP 接口，中枢目前只支持第二代。');
  }
  if (has(raw, '_wled._tcp') || (raw.http?.wled ?? false)) {
    return out('lan-api', 'WLED 灯效固件：局域网 JSON 接口能读状态、切灯效。');
  }
  if (info.espressif) {
    return out(
      'flashable',
      'ESP 芯片的设备：多半能刷 ESPHome / Tasmota 换成自己的固件。接 220V 的别拆机刷，先查这款能不能免拆刷。',
    );
  }
  if (
    raw.ssdp?.types.some((type) => /internetgatewaydevice|wanipconnection/i.test(type)) ||
    /routeros|openwrt|\brouter\b|\bgateway\b|路由/.test(text) ||
    (port(raw, 53) && port(raw, 80, 443) && !pcLike)
  ) {
    return out('router', '路由器：后台里能看到每台设备的名字，认不出的设备可以去那里对一下。');
  }
  if (has(raw, '_hue._tcp') || /philips hue/.test(text)) {
    return out('lan-api', '飞利浦 Hue 桥：局域网接口能读灯的状态和控制（要先在桥上按键配对）。');
  }
  if (has(raw, '_hap._tcp')) {
    return out('lan-api', 'HomeKit 配件：局域网能读真实状态，但要先配对。');
  }
  if (has(raw, '_matter._tcp', '_matterc._udp')) {
    return out('lan-api', 'Matter 设备：标准局域网协议，能读状态和控制（要先配网/配对）。');
  }
  if (has(raw, '_miio._udp')) {
    return out('lan-api', '小米 miIO 设备：局域网能读状态，但要先拿到设备 token。');
  }
  if (!pcLike && port(raw, 55443)) {
    return out('lan-api', 'Yeelight 灯：开了局域网控制，能直接读开关、亮度、颜色。');
  }
  if (!pcLike && port(raw, 6668)) {
    return out('lan-api', '涂鸦设备：局域网协议能读状态，需要设备的本地密钥。有的型号能刷固件。');
  }
  if (!pcLike && port(raw, 9999)) {
    return out('lan-api', 'TP-Link Kasa 设备：局域网协议能读开关和用电。');
  }
  if (
    has(raw, '_googlecast._tcp', '_androidtvremote2._tcp') ||
    (!pcLike &&
      (has(raw, '_airplay._tcp', '_raop._tcp', '_spotify-connect._tcp') ||
        port(raw, 8008, 8009, 8001, 1400, 7000) ||
        raw.ssdp?.types.some((type) => /mediarenderer/i.test(type)) ||
        /television|\btv\b|dlna|sonos/.test(text)) &&
      !/microsoft|windows/.test(text))
  ) {
    return out(
      'media',
      port(raw, 5555)
        ? '电视/盒子，而且开着安卓调试口：能读到真实开关和正在放什么，比红外强。'
        : '电视/音箱：局域网能读到是否开着、正在放什么（红外做不到），还能投屏、控制播放。',
    );
  }
  if ((!pcLike && port(raw, 554)) || /\b(?:ip ?camera|camera|nvr|webcam)\b|摄像/.test(text)) {
    return out('camera', '摄像头：有 RTSP 视频流，填账号密码就能把画面接进来。');
  }
  if (
    has(raw, '_ipp._tcp', '_printer._tcp', '_pdl-datastream._tcp') ||
    (!pcLike && port(raw, 9100))
  ) {
    return out('printer', '打印机：局域网能查墨量、纸张和故障状态。');
  }
  if (info.vendor === '树莓派') {
    return out('computer', '树莓派：可以当常开的中枢或跑 Home Assistant。');
  }
  if (port(raw, 62078)) return out('phone', 'iPhone / iPad。');
  if (pcLike || port(raw, 22)) {
    return out('computer', '电脑或 NAS。');
  }
  if (info.random) return out('phone', '多半是手机或平板（用了随机 MAC）。');
  return out('unknown', '没开常见接口，认不出。可以到路由器后台按 IP 对一下名字。');
}

/** 错误页、登录页的标题不当设备名。 */
const genericTitle =
  /^(?:\d{3}\b|not found|forbidden|unauthorized|bad request|index of|welcome|login|log in|error|document|untitled|登录|登陆)/i;

/** 在线的电脑多、设备多，多半不是家里。 */
export function looksLikeOffice(devices: readonly LanDevice[]): boolean {
  const computers = devices.filter((item) => item.category === 'computer' && !item.self).length;
  return devices.length > 60 || computers >= 12;
}

export function sortDevices(devices: readonly LanDevice[]): LanDevice[] {
  return [...devices].sort((a, b) => {
    if (a.self !== b.self) return a.self ? 1 : -1;
    const order = lanCategories.indexOf(a.category) - lanCategories.indexOf(b.category);
    return order !== 0 ? order : (ipToInt(a.ip) ?? 0) - (ipToInt(b.ip) ?? 0);
  });
}

/* ---------------- 状态 ---------------- */

export interface LanScanResult {
  at: number;
  subnet: string;
  scanned: number;
  durationMs: number;
  devices: LanDevice[];
  /** 扫描过程中值得告诉用户的事：比如 mDNS 端口被占了。 */
  notes: string[];
}

export interface LanScanState {
  running: boolean;
  /** 进行中时的一句话进度。 */
  progress: string;
  subnets: LanSubnet[];
  last: LanScanResult | null;
  error: string;
}

export const emptyLanScanState = (): LanScanState => ({
  running: false,
  progress: '',
  subnets: [],
  last: null,
  error: '',
});

/** 存盘的上次结果：坏了就当没有。 */
export function normalizeLanResult(raw: unknown): LanScanResult | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value['at'] !== 'number' || typeof value['subnet'] !== 'string') return null;
  if (!Array.isArray(value['devices'])) return null;
  const devices = (value['devices'] as unknown[])
    .filter(
      (item): item is LanDevice =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as LanDevice).ip === 'string' &&
        lanCategories.includes((item as LanDevice).category) &&
        Array.isArray((item as LanDevice).evidence),
    )
    .slice(0, lanScanLimits.maxDevices);
  return {
    at: value['at'],
    subnet: value['subnet'],
    scanned: typeof value['scanned'] === 'number' ? value['scanned'] : 0,
    durationMs: typeof value['durationMs'] === 'number' ? value['durationMs'] : 0,
    devices,
    notes: Array.isArray(value['notes'])
      ? (value['notes'] as unknown[])
          .filter((note): note is string => typeof note === 'string')
          .slice(0, 10)
      : [],
  };
}
