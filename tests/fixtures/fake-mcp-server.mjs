// 测试用的 stdio MCP 服务器：一行一条 JSON-RPC。
// 故意先往 stdout 打一行非 JSON 的日志，验证客户端会跳过。
import { createInterface } from 'node:readline';

process.stdout.write('fake server booting...\n');
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const token = process.env.FAKE_TOKEN ?? '';

const tools = [
  {
    name: 'echo',
    description: '原样返回 text',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  { name: 'whoami', description: '返回环境里的 token', inputSchema: { type: 'object' } },
  { name: 'broken', description: '总是报错', inputSchema: { type: 'object' } },
  { name: 'slow', description: '永远不回', inputSchema: { type: 'object' } },
];

createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '1' },
      },
    });
  } else if (method === 'tools/list') {
    // 分两页，验证客户端会翻页
    if (!params?.cursor)
      send({ jsonrpc: '2.0', id, result: { tools: tools.slice(0, 2), nextCursor: 'p2' } });
    else send({ jsonrpc: '2.0', id, result: { tools: tools.slice(2) } });
  } else if (method === 'tools/call') {
    const name = params.name;
    if (name === 'echo') {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `echo:${params.arguments.text}` }] },
      });
    } else if (name === 'whoami') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `token=${token}` }] } });
    } else if (name === 'broken') {
      send({
        jsonrpc: '2.0',
        id,
        result: { isError: true, content: [{ type: 'text', text: 'boom' }] },
      });
    }
    // slow：不回
  } else if (method === 'exit-now') {
    process.exit(3);
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'nope' } });
  }
});
