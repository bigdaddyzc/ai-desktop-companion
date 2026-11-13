import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { HttpChannel, McpClient } from '../src/desktop/mcp-client';

const request = { jsonrpc: '2.0' as const, id: 1, method: 'ping' };
const reply = { jsonrpc: '2.0', id: 1, result: { text: '芯伴，你好 🤖' } };
function channelFor(chunks: Uint8Array[], options: { close?: boolean; type?: string } = {}) {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (options.close) controller.close();
    },
    cancel,
  });
  const fetcher: typeof fetch = async () =>
    new Response(stream, { headers: { 'Content-Type': options.type ?? 'text/event-stream' } });
  return { channel: new HttpChannel('http://localhost/mcp', {}, fetcher), cancel, stream };
}
const bytes = (text: string) => new TextEncoder().encode(text);

describe('MCP SSE interoperability and recovery', () => {
  it.each(['\n', '\r\n', '\r'])(
    'real HTTP persistent stream responds with newline %j without EOF',
    async (nl) => {
      const server = createServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `: heartbeat${nl}${nl}event: message${nl}data: ${JSON.stringify(reply)}${nl}${nl}`,
        );
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      try {
        const channel = new HttpChannel(`http://127.0.0.1:${address.port}`, {});
        await expect(channel.request(request, AbortSignal.timeout(3000))).resolves.toEqual(reply);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
      }
    },
  );
  it.each(['\n', '\r\n', '\r'])('one-byte chunks preserve UTF8 and separators %j', async (nl) => {
    const body = bytes(`data: ${JSON.stringify(reply)}${nl}${nl}`);
    const f = channelFor(Array.from(body, (b) => Uint8Array.of(b)));
    await expect(f.channel.request(request, AbortSignal.timeout(3000))).resolves.toEqual(reply);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.stream.locked).toBe(false);
  });
  it('ignores malformed events and other IDs, joins data lines, isolates notification observers', async () => {
    const body =
      ': heartbeat\r\n\r\ndata: null\r\n\r\ndata: 123\r\n\r\ndata: broken\r\n\r\n' +
      'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\r\n\r\n' +
      'data: {"jsonrpc":"2.0","id":99,"result":"wrong"}\r\n\r\n' +
      'data: {"jsonrpc":"2.0","id":1,"method":"server-request"}\r\n\r\n' +
      'data: {"jsonrpc":"2.0",\r\ndata: "id":1,"result":"correct"}\r\n\r\n';
    const f = channelFor([bytes(body)]);
    const listener = vi.fn();
    f.channel.onNotification(() => {
      throw new Error('observer failure');
    });
    f.channel.onNotification(listener);
    await expect(f.channel.request(request, AbortSignal.timeout(3000))).resolves.toMatchObject({
      result: 'correct',
    });
    expect(listener).toHaveBeenCalledWith('notifications/tools/list_changed');
    expect(f.cancel).toHaveBeenCalledTimes(1);
  });
  it('does not dispatch an incomplete SSE event at EOF', async () => {
    const f = channelFor([bytes(`data: ${JSON.stringify(reply)}\n`)], { close: true });
    await expect(f.channel.request(request, AbortSignal.timeout(3000))).rejects.toThrow('流结束');
    expect(f.stream.locked).toBe(false);
  });
  it.each(['text/event-stream', 'application/json'])(
    'oversized %s is rejected and reader released',
    async (type) => {
      const f = channelFor([new Uint8Array(4 * 1024 * 1024 + 1)], { type });
      await expect(f.channel.request(request, AbortSignal.timeout(3000))).rejects.toThrow('太大');
      expect(f.cancel).toHaveBeenCalledTimes(1);
      expect(f.stream.locked).toBe(false);
    },
  );
  it.each(['text/event-stream', 'application/json'])(
    'aborting a stalled %s reader cancels it, even with signal-ignorant fetch',
    async (type) => {
      const f = channelFor([], { type });
      const controller = new AbortController();
      const pending = f.channel.request(request, controller.signal);
      const assertion = expect(pending).rejects.toThrow('aborted');
      await new Promise<void>((done) => setImmediate(done));
      controller.abort();
      await assertion;
      expect(f.cancel).toHaveBeenCalledTimes(1);
      expect(f.stream.locked).toBe(false);
    },
  );
  it('client timeout sends cancellation and the next request succeeds (20 recovery cycles)', async () => {
    const cancelled = vi.fn();
    const streams: ReadableStream[] = [];
    let pending = true;
    let notices = 0;
    const fetcher: typeof fetch = async (_url, options) => {
      const input = JSON.parse(String(options?.body)) as { id?: number; method?: string };
      if (input.id === undefined) {
        notices++;
        return new Response(null, { status: 202 });
      }
      if (!pending) return Response.json({ jsonrpc: '2.0', id: input.id, result: 'recovered' });
      const stream = new ReadableStream({ cancel: cancelled });
      streams.push(stream);
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const client = new McpClient(new HttpChannel('http://localhost', {}, fetcher));
    for (let i = 0; i < 20; i++) {
      pending = true;
      await expect(client.call('ping', {}, 15)).rejects.toThrow('没回应');
      pending = false;
      await expect(client.call('ping', {}, 3000)).resolves.toBe('recovered');
    }
    expect(cancelled).toHaveBeenCalledTimes(20);
    expect(notices).toBe(20);
    expect(streams.every((stream) => !stream.locked)).toBe(true);
  });
  it.each([
    'null',
    '{"id":1,"result":"wrong-protocol"}',
    '{"jsonrpc":"2.0","id":1,"method":"server-request"}',
  ])('invalid JSON-RPC reply %s is not success', async (body) => {
    const f = channelFor([bytes(body)], { close: true, type: 'application/json' });
    await expect(f.channel.request(request, AbortSignal.timeout(3000))).rejects.toThrow('没有这条');
  });
  it('HTTP errors do not consume unbounded error bodies', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const channel = new HttpChannel(
      'http://localhost',
      {},
      async () => new Response(body, { status: 401 }),
    );
    await expect(channel.request(request, AbortSignal.timeout(3000))).rejects.toThrow('401');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('closing a session cancels DELETE response body and forbids redirects', async () => {
    const cancel = vi.fn();
    let deleteOptions: RequestInit | undefined;
    const fetcher: typeof fetch = async (_url, options) => {
      if (options?.method === 'DELETE') {
        deleteOptions = options;
        return new Response(new ReadableStream({ cancel }));
      }
      return Response.json(reply, { headers: { 'Mcp-Session-Id': 'local-session' } });
    };
    const channel = new HttpChannel('http://localhost', {}, fetcher);
    await channel.request(request, AbortSignal.timeout(3000));
    channel.close();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(deleteOptions?.redirect).toBe('error');
    channel.close();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('MCP HTTP: server requests, id:null errors and bare data lines', () => {
  it('answers server ping/unknown requests on the stream with the session header', async () => {
    const posted: {
      body: { id?: unknown; result?: unknown; error?: { code: number } };
      session: string | null;
    }[] = [];
    const sse =
      'data: {"jsonrpc":"2.0","id":"s1","method":"ping"}\n\n' +
      'data: {"jsonrpc":"2.0","id":"s2","method":"elicitation/create"}\n\n' +
      `data: ${JSON.stringify(reply)}\n\n`;
    let first = true;
    const fetcher: typeof fetch = async (_url, options) => {
      if (first) {
        first = false;
        return new Response(bytes(sse), {
          headers: { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'sess-1' },
        });
      }
      posted.push({
        body: JSON.parse(String(options?.body)),
        session: new Headers(options?.headers).get('Mcp-Session-Id'),
      });
      return new Response(null, { status: 202 });
    };
    const channel = new HttpChannel('http://localhost', {}, fetcher);
    await expect(channel.request(request, AbortSignal.timeout(3000))).resolves.toEqual(reply);
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted.find((p) => p.body.id === 's1')?.body.result).toEqual({});
    expect(posted.find((p) => p.body.id === 's2')?.body.error?.code).toBe(-32601);
    expect(posted.every((p) => p.session === 'sess-1')).toBe(true);
  });
  it.each(['text/event-stream', 'application/json'])(
    'id:null error reply (%s) is surfaced instead of waiting for EOF',
    async (type) => {
      const error = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
      const body =
        type === 'application/json' ? JSON.stringify(error) : `data: ${JSON.stringify(error)}\n\n`;
      const f = channelFor([bytes(body)], { type, close: type === 'application/json' });
      await expect(f.channel.request(request, AbortSignal.timeout(3000))).resolves.toMatchObject({
        error: { code: -32700 },
      });
    },
  );
  it('a bare data line is an empty data field, not dropped', async () => {
    const f = channelFor([bytes(`data: {"jsonrpc":"2.0","id":1,\ndata\ndata: "result":"ok"}\n\n`)]);
    await expect(f.channel.request(request, AbortSignal.timeout(3000))).resolves.toMatchObject({
      result: 'ok',
    });
  });
});
