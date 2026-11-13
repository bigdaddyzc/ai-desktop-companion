import { execFile } from 'node:child_process';
import { createSocket, type Socket } from 'node:dgram';
import { reverse } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import {
  classifyHost,
  emptyLanScanState,
  inSubnet,
  lanScanLimits,
  looksLikeOffice,
  lanSubnets,
  mdnsAddress,
  mdnsByHost,
  mdnsPort,
  mdnsQuery,
  mergeMdns,
  normalizeLanResult,
  parseDnsPacket,
  parseHttpHome,
  parseNeighbors,
  parseShelly,
  parseSsdpResponse,
  parseUpnpDescription,
  probePorts,
  safeLocation,
  sortDevices,
  ssdpAddress,
  ssdpPort,
  ssdpSearch,
  subnetHosts,
  type HttpInfo,
  type LanHostRaw,
  type LanScanResult,
  type LanScanState,
  type LanSubnet,
  type MdnsInfo,
  type SsdpInfo,
} from '../core/lan-scan';
import { writeJsonAtomic } from './atomic';

export type ProbeResult = 'open' | 'closed' | 'silent';

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface ListenResult {
  mdns: Map<string, MdnsInfo>;
  ssdp: Map<string, { server?: string; location?: string; types: string[] }>;
  notes: string[];
}

/** 所有碰网络的动作都从这里注入：测试里换成假的。 */
export interface LanScanDeps {
  interfaces: () => ReturnType<typeof networkInterfaces>;
  probe: (ip: string, port: number, timeoutMs: number) => Promise<ProbeResult>;
  neighbors: () => Promise<string>;
  listen: (subnet: LanSubnet, waitMs: number) => Promise<ListenResult>;
  http: (url: string, timeoutMs: number) => Promise<HttpResponse | null>;
  reverse: (ip: string) => Promise<string | null>;
  now: () => number;
}

export function tcpProbe(ip: string, port: number, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = connect({ host: ip, port });
    let done = false;
    const finish = (result: ProbeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish('silent'), timeoutMs);
    socket.once('connect', () => finish('open'));
    socket.once('error', (error: NodeJS.ErrnoException) =>
      finish(error.code === 'ECONNREFUSED' ? 'closed' : 'silent'),
    );
  });
}

function readNeighbors(): Promise<string> {
  const [command, args] =
    process.platform === 'win32' ? ['arp', ['-a']] : ['ip', ['neigh', 'show']];
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: 5_000, windowsHide: true, encoding: 'latin1' },
      (error, stdout) => resolve(error ? '' : stdout),
    );
  });
}

/** GET 一个局域网地址：不跟跳转、限时、限量。 */
export function httpGet(url: string, timeoutMs: number): Promise<HttpResponse | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: HttpResponse | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      resolve(value);
    };
    const req = request(
      url,
      { method: 'GET', headers: { 'user-agent': 'xinban-lan-scan' } },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          chunks.push(chunk);
          if (size >= lanScanLimits.httpBodyBytes) res.destroy();
        });
        const end = () =>
          finish({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).subarray(0, lanScanLimits.httpBodyBytes).toString('utf8'),
          });
        res.on('end', end);
        res.on('close', end);
        res.on('error', end);
      },
    );
    const timer = setTimeout(() => finish(null), timeoutMs);
    req.on('error', () => finish(null));
    req.end();
  });
}

async function reverseName(ip: string): Promise<string | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_500));
  const lookup = reverse(ip)
    .then((names) => names[0] ?? null)
    .catch(() => null);
  return Promise.race([lookup, timeout]);
}

/**
 * 在选定网卡上发 mDNS 和 SSDP 的「谁在？」，听 waitMs。
 * mDNS 两路一起走：随机端口发（对方单播回答），再试着加入 5353 组播听组播回答；
 * 5353 被系统占了也不要紧，只少一点结果。
 */
export async function listenLan(subnet: LanSubnet, waitMs: number): Promise<ListenResult> {
  const result: ListenResult = { mdns: new Map(), ssdp: new Map(), notes: [] };
  const sockets: Socket[] = [];
  const onMdns = (message: Buffer, from: { address: string }) => {
    if (!inSubnet(from.address, subnet)) return;
    for (const [ip, info] of mdnsByHost(parseDnsPacket(message), from.address)) {
      if (inSubnet(ip, subnet)) result.mdns.set(ip, mergeMdns(result.mdns.get(ip), info));
    }
  };
  const open = (
    port: number,
    onMessage: (message: Buffer, from: { address: string }) => void,
    group?: string,
  ) =>
    new Promise<Socket | null>((resolve) => {
      const socket = createSocket({ type: 'udp4', reuseAddr: port !== 0 });
      socket.once('error', () => {
        socket.close();
        resolve(null);
      });
      socket.on('message', onMessage);
      socket.bind({ port, address: port === 0 ? subnet.address : undefined }, () => {
        try {
          socket.setMulticastInterface(subnet.address);
          if (group) socket.addMembership(group, subnet.address);
        } catch {
          socket.close();
          resolve(null);
          return;
        }
        socket.removeAllListeners('error');
        socket.on('error', () => undefined);
        sockets.push(socket);
        resolve(socket);
      });
    });
  const send = (socket: Socket | null, packet: Buffer, host: string, port: number) =>
    socket?.send(packet, port, host, () => undefined);
  try {
    const unicast = await open(0, onMdns);
    const group = await open(mdnsPort, onMdns, mdnsAddress);
    const ssdp = await open(0, (message, from) => {
      if (!inSubnet(from.address, subnet)) return;
      const parsed = parseSsdpResponse(message.toString('utf8'));
      if (!parsed) return;
      const item = result.ssdp.get(from.address) ?? { types: [] };
      item.server ??= parsed.server;
      item.location ??= parsed.location;
      if (parsed.st && !item.types.includes(parsed.st) && item.types.length < 12)
        item.types.push(parsed.st);
      result.ssdp.set(from.address, item);
    });
    if (!unicast && !group)
      result.notes.push('mDNS 发不出去，电视、投屏、ESPHome 这类可能认不出来。');
    if (!ssdp) result.notes.push('SSDP 发不出去，电视、路由器的型号可能认不出来。');
    const query = mdnsQuery();
    const search = ssdpSearch();
    for (const delay of [0, 1_000]) {
      setTimeout(() => {
        send(unicast, query, mdnsAddress, mdnsPort);
        send(group, query, mdnsAddress, mdnsPort);
        send(ssdp, search, ssdpAddress, ssdpPort);
      }, delay).unref?.();
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  } finally {
    for (const socket of sockets) {
      try {
        socket.close();
      } catch {
        // 已经关了。
      }
    }
  }
  return result;
}

export const defaultLanScanDeps: LanScanDeps = {
  interfaces: networkInterfaces,
  probe: tcpProbe,
  neighbors: readNeighbors,
  listen: listenLan,
  http: httpGet,
  reverse: reverseName,
  now: Date.now,
};

async function pool<T>(
  items: readonly T[],
  size: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

function cleanHostname(name: string | null | undefined, ip: string): string | undefined {
  if (!name) return undefined;
  const short = name.replace(/\.(local|lan|home|localdomain)\.?$/i, '').trim();
  return short && short !== ip ? short.slice(0, 60) : undefined;
}

/**
 * 家庭设备普查。一次只跑一个扫描；上次的结果存 lan-scan-v1.json，重启后面板还看得到。
 * 顺序：广播问谁在 + 整段敲 80 端口（顺便让系统学到每台的 MAC）→ 读邻居表 →
 * 对在线的敲常见端口 → 开着网页的取首页、取 UPnP 描述 → 识别。
 */
export class LanScanService {
  private state: LanScanState = emptyLanScanState();
  private readonly listeners = new Set<(state: LanScanState) => void>();

  constructor(
    private readonly path: string,
    private readonly deps: LanScanDeps = defaultLanScanDeps,
  ) {}

  async load(): Promise<void> {
    try {
      this.state = {
        ...this.state,
        last: normalizeLanResult(JSON.parse(await readFile(this.path, 'utf8'))),
      };
    } catch {
      // 没扫过。
    }
    this.refreshSubnets();
  }

  snapshot(): LanScanState {
    return this.state;
  }

  subscribe(listener: (state: LanScanState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  refreshSubnets(): LanSubnet[] {
    const subnets = lanSubnets(this.deps.interfaces());
    this.set({ subnets });
    return subnets;
  }

  private set(patch: Partial<LanScanState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  /** 发起一次扫描；立刻返回，进度和结果走 subscribe。 */
  start(key: unknown): { ok: true } | { ok: false; error: string } {
    if (this.state.running) return { ok: false, error: '已经在扫了。' };
    const subnets = this.refreshSubnets();
    const subnet =
      typeof key === 'string' && key !== '' ? subnets.find((item) => item.key === key) : subnets[0];
    if (!subnet) {
      return {
        ok: false,
        error:
          subnets.length === 0
            ? '这台电脑没连在家庭局域网里（没找到 192.168 / 10 / 172.16 的地址）。'
            : '这个网段已经不在了，刷新后重选。',
      };
    }
    this.set({ running: true, error: '', progress: '开始…' });
    void this.run(subnet).then(
      (result) => {
        this.set({ running: false, progress: '', last: result });
        void writeJsonAtomic(this.path, result).catch(() => undefined);
      },
      (error: unknown) => {
        this.set({
          running: false,
          progress: '',
          error: `扫描出错：${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            200,
          ),
        });
      },
    );
    return { ok: true };
  }

  /** 真正的扫描。导出给测试和命令行自测直接用。 */
  async run(subnet: LanSubnet): Promise<LanScanResult> {
    const { deps } = this;
    const started = deps.now();
    const hosts = subnetHosts(subnet).filter((ip) => ip !== subnet.address);
    const raw = new Map<string, LanHostRaw>();
    const host = (ip: string): LanHostRaw => {
      let item = raw.get(ip);
      if (!item) {
        item = { ip, ports: [] };
        raw.set(ip, item);
      }
      return item;
    };

    this.set({ progress: `在 ${subnet.key} 里问一声谁在…` });
    const listening = deps.listen(subnet, lanScanLimits.listenMs);
    let knocked = 0;
    await pool(hosts, lanScanLimits.concurrency, async (ip) => {
      const result = await deps.probe(ip, 80, lanScanLimits.probeTimeoutMs);
      if (result === 'open') host(ip).ports.push(80);
      else if (result === 'closed') host(ip);
      knocked += 1;
      if (knocked % 32 === 0) this.set({ progress: `敲门 ${knocked}/${hosts.length}…` });
    });
    const heard = await listening;
    for (const neighbor of parseNeighbors(await deps.neighbors())) {
      if (neighbor.ip === subnet.address || !inSubnet(neighbor.ip, subnet)) continue;
      host(neighbor.ip).mac = neighbor.mac;
    }
    for (const [ip, info] of heard.mdns) if (ip !== subnet.address) host(ip).mdns = info;
    for (const [ip, info] of heard.ssdp) {
      if (ip !== subnet.address)
        host(ip).ssdp = { server: info.server, location: info.location, types: info.types };
    }

    const alive = [...raw.values()];
    this.set({ progress: `找到 ${alive.length} 台，看看各自开了什么…` });
    const jobs = alive.flatMap((item) =>
      probePorts.filter((value) => value !== 80).map((value) => ({ item, port: value })),
    );
    await pool(jobs, lanScanLimits.concurrency, async ({ item, port }) => {
      if ((await deps.probe(item.ip, port, lanScanLimits.probeTimeoutMs)) === 'open')
        item.ports.push(port);
    });

    this.set({ progress: '认一认都是什么设备…' });
    await pool(alive, 8, async (item) => {
      const [name, http, upnp] = await Promise.all([
        deps.reverse(item.ip),
        item.ports.includes(80) ? this.fingerprint(item.ip) : Promise.resolve(undefined),
        this.describe(item.ip, item.ssdp),
      ]);
      item.hostname = cleanHostname(name, item.ip);
      if (http) item.http = http;
      if (upnp && item.ssdp) item.ssdp = { ...item.ssdp, ...upnp };
    });

    const self = classifyHost({ ip: subnet.address, ports: [], self: true });
    const devices = sortDevices([...alive.map(classifyHost), self]);
    return {
      at: deps.now(),
      subnet: subnet.key,
      scanned: hosts.length,
      durationMs: deps.now() - started,
      devices,
      notes: [
        ...(subnet.narrowed ? [`网卡的网段比 /24 大，只扫了本机附近的 ${subnet.key}。`] : []),
        ...heard.notes,
        ...(looksLikeOffice(devices)
          ? [
              '这里电脑和设备很多，看起来是办公网络而不是家里。公司网络请别再扫：可能违反 IT 规定、触发安全告警。',
            ]
          : []),
      ],
    };
  }

  private async fingerprint(ip: string): Promise<HttpInfo | undefined> {
    const home = await this.deps.http(`http://${ip}/`, lanScanLimits.httpTimeoutMs);
    if (!home) return undefined;
    const info = parseHttpHome(home.headers, home.body);
    if (info.tasmota || info.esphome) return info;
    const shelly = await this.deps.http(`http://${ip}/shelly`, lanScanLimits.httpTimeoutMs);
    if (shelly && shelly.status === 200) info.shelly = parseShelly(shelly.body);
    return info;
  }

  private async describe(
    ip: string,
    ssdp: SsdpInfo | undefined,
  ): Promise<Partial<SsdpInfo> | undefined> {
    const url = safeLocation(ssdp?.location, ip);
    if (!url) return undefined;
    const response = await this.deps.http(url, lanScanLimits.httpTimeoutMs);
    return response && response.status === 200 ? parseUpnpDescription(response.body) : undefined;
  }
}
