/**
 * 评测主程序（在 Electron 里跑：解密密钥要用 safeStorage）。用 `npm run eval` 启动，不要直接跑。
 *
 * 隔离：
 * - 开一个临时 userData，只从真实数据目录复制两个文件：加密的密钥和解密它要的 Local State；
 * - 记忆、性格、派活配置、项目目录全用 cases.ts 里的合成数据；
 * - 不执行任何工具；结束后删掉临时目录（里面有密钥副本）。
 *
 * 产出：scripts/eval/results/latest.json、report.md；上一次的结果转成 previous.json 用来对比。
 */
import { app, safeStorage } from 'electron';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolsFor } from '../../src/core/agent';
import {
  defaultDelegate,
  delegatePrompt,
  delegateTargets,
  type DelegateConfig,
} from '../../src/core/delegate';
import { hasDsml } from '../../src/core/dsml';
import { buildInstructions, defaultPersona } from '../../src/core/persona';
import {
  buildResponsesBody,
  historyItems,
  readOutput,
  responsesEndpoint,
} from '../../src/core/responses';
import { AiCredentialStore } from '../../src/desktop/ai-credentials';
import { MemoryService, MemoryStore } from '../../src/desktop/memory';
import { attachmentLine, attachmentPrompt, type AttachmentInfo } from '../../src/core/attachments';
import { fileRootsPrompt } from '../../src/core/file-roots';
import { mcpPrompt, mcpToolSpec, type McpServerView } from '../../src/core/mcp';
import { wrapUntrusted } from '../../src/core/agent';
import {
  evalCases,
  fixtureAttachments,
  fixtureAttachmentTexts,
  fixtureFacts,
  fixtureMcp,
  fixtureProjects,
  fixtureRoots,
  type EvalCase,
} from './cases';
import { report, scoreRun, summarize, type EvalRun, type EvalSummary } from './score';

const source =
  process.env['XINBAN_EVAL_SOURCE'] ||
  join(process.env['APPDATA'] ?? app.getPath('appData'), '芯伴');
const resultsDir =
  process.env['XINBAN_EVAL_OUT'] || join(process.cwd(), 'scripts', 'eval', 'results');
// 临时目录由启动器（eval.mjs）建、等 Electron 退出后删：Chromium 在进程活着时会占着里面的文件，
// 在这里删会失败并把密钥副本留在磁盘上。直接跑 run.cjs 时才自己建、自己尽力删。
const ownSandbox = !process.env['XINBAN_EVAL_SANDBOX'];
const sandbox = process.env['XINBAN_EVAL_SANDBOX'] || mkdtempSync(join(tmpdir(), 'xinban-eval-'));
// Local State 里有 safeStorage 的密钥：Chromium 启动时就读，必须在 ready 之前同步放好。
for (const name of ['Local State', 'ai-credentials-v1.json']) {
  try {
    copyFileSync(join(source, name), join(sandbox, name));
  } catch {
    // 缺哪个后面会报「没配置模型」
  }
}
app.setPath('userData', sandbox);

const rounds = Math.max(1, Number(process.env['ROUNDS'] ?? '2'));
const only = (process.env['ONLY'] ?? '').split(',').filter((item) => item !== '');
const concurrency = Math.max(1, Number(process.env['CONCURRENCY'] ?? '4'));

function parseStream(raw: string): unknown[] | null {
  let output: unknown[] | null = null;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const event = JSON.parse(line.slice(5).trim()) as {
        type?: string;
        response?: { output?: unknown[] };
      };
      if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        output = event.response?.output ?? [];
      }
    } catch {
      // 心跳或垃圾行
    }
  }
  return output;
}

async function main(): Promise<void> {
  const credentials = await new AiCredentialStore(join(sandbox, 'ai-credentials-v1.json'), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (payload) => safeStorage.decryptString(payload),
  }).load();
  if (!credentials) throw new Error(`没读到模型配置：先在芯伴里配好模型（来源 ${source}）`);

  const memory = new MemoryService(new MemoryStore(join(sandbox, 'memory-v1.json')));
  await memory.init();
  for (const fact of fixtureFacts) await memory.remember(fact.text, fact.category, 'said');

  const projectsRoot = join(sandbox, 'projects');
  for (const name of fixtureProjects) mkdirSync(join(projectsRoot, name), { recursive: true });
  const projects = fixtureProjects.map((name) => ({ name, path: join(projectsRoot, name) }));
  const config: DelegateConfig = {
    ...defaultDelegate,
    allowAgents: true,
    allowShell: true,
    // 和用户默认一致：自动挑、用不了自动换。点名题仍要求填对点名的那个。
    target: 'auto',
    projectsRoot,
  };
  const targets = delegateTargets.map((target) => ({
    id: target.id,
    label: target.label,
    available: true,
  }));
  const endpoint = responsesEndpoint(credentials.baseUrl);
  const selected =
    only.length > 0
      ? evalCases.filter((item) => only.includes(item.id) || only.includes(item.group))
      : evalCases;
  const queue = selected.flatMap((spec) =>
    Array.from({ length: rounds }, (_, round) => ({ spec, round })),
  );
  const runs: EvalRun[] = [];

  // 和 main.ts 一样：授权目录与 MCP 说明拼在派活那一段，MCP 工具追加在内置工具后面。
  const mcpView: McpServerView = {
    name: fixtureMcp.server,
    transport: 'stdio',
    command: 'npx',
    args: [],
    cwd: '',
    url: '',
    enabled: true,
    trust: 'ask',
    toolTrust: {},
    envKeys: [],
    headerKeys: [],
    state: 'ready',
    error: '',
    tools: fixtureMcp.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      trust: 'ask' as const,
    })),
  };
  const environment = [
    delegatePrompt(config, targets as never, projects),
    fileRootsPrompt(fixtureRoots),
    mcpPrompt([mcpView]),
  ].join('\n\n');
  const tools = [
    ...toolsFor(true),
    ...fixtureMcp.tools.map((tool) => mcpToolSpec(fixtureMcp.server, tool)),
  ];

  async function runOne(spec: EvalCase, round: number): Promise<EvalRun> {
    const instructions = buildInstructions(
      memory.promptFor(spec.text),
      Date.now(),
      '',
      defaultPersona,
      '',
      environment,
    );
    const attached = fixtureAttachments.filter((item) => spec.attach?.includes(item.id));
    const content =
      attached.length === 0
        ? spec.text
        : `${spec.text}\n\n${attachmentLine(attached as readonly AttachmentInfo[])}\n\n${attachmentPrompt(
            attached as readonly AttachmentInfo[],
            new Map(Object.entries(fixtureAttachmentTexts)),
            wrapUntrusted,
          )}`;
    const started = Date.now();
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credentials!.apiKey}`,
        },
        body: buildResponsesBody({
          model: credentials!.model,
          instructions,
          input: [...historyItems(spec.history ?? []), { role: 'user', content }],
          stream: true,
          tools,
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) {
        return {
          id: spec.id,
          round,
          text: '',
          calls: [],
          ms: Date.now() - started,
          error: `HTTP ${response.status}`,
        };
      }
      const output = parseStream(await response.text());
      if (output === null) {
        return {
          id: spec.id,
          round,
          text: '',
          calls: [],
          ms: Date.now() - started,
          error: '流没有正常结束',
        };
      }
      const plan = readOutput(output);
      return {
        id: spec.id,
        round,
        text: plan.text,
        calls: plan.calls.map((call) => ({ name: call.name, args: call.arguments })),
        ms: Date.now() - started,
        dsml: hasDsml(plan.text),
      };
    } catch (error) {
      return {
        id: spec.id,
        round,
        text: '',
        calls: [],
        ms: Date.now() - started,
        error: String(error),
      };
    }
  }

  let done = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const run = await runOne(next.spec, next.round);
        runs.push(run);
        done += 1;
        const verdict = scoreRun(next.spec, run);
        console.log(
          `[${done}/${selected.length * rounds}] ${verdict.pass ? 'PASS' : 'FAIL'} ${run.id}#${run.round}` +
            (verdict.pass ? '' : ` — ${verdict.reasons.join('；')}`),
        );
      }
    }),
  );

  const byId = new Map(evalCases.map((spec) => [spec.id, spec]));
  const verdicts = runs.map((run) => scoreRun(byId.get(run.id)!, run));
  const summary = summarize(verdicts, runs, { at: Date.now(), model: credentials.model, rounds });
  mkdirSync(resultsDir, { recursive: true });
  const latest = join(resultsDir, 'latest.json');
  let previous: EvalSummary | null = null;
  try {
    previous = JSON.parse(await readFile(latest, 'utf8')) as EvalSummary;
    await rename(latest, join(resultsDir, 'previous.json'));
  } catch {
    previous = null;
  }
  await writeFile(latest, JSON.stringify(summary, null, 1), 'utf8');
  // 原始回复单独放：排查时看，不参与对比。
  await writeFile(join(resultsDir, 'runs.json'), JSON.stringify(runs, null, 1), 'utf8');
  const markdown = report(summary, previous);
  await writeFile(join(resultsDir, 'report.md'), markdown, 'utf8');
  console.log(`\n${markdown}`);
}

void app.whenReady().then(async () => {
  let code = 0;
  try {
    await main();
  } catch (error) {
    console.error('评测失败：', error instanceof Error ? error.message : error);
    code = 1;
  } finally {
    if (ownSandbox) {
      try {
        rmSync(sandbox, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        console.error(`临时目录没删掉（里面有密钥副本），请手动删：${sandbox}`);
      }
    }
    app.exit(code);
  }
});
