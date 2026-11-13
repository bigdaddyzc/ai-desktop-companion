import { build } from 'esbuild';
import { FileAccessService } from '../src/desktop/files';
import { captureFile } from '../src/desktop/file-transaction';
import { appVersion } from '../src/core/version';
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { durableState, initialState, reduce } from '../src/core/state';
import { visionLimits } from '../src/core/vision';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
let app: ElectronApplication | undefined;
let directory: string;
const errors: string[] = [];
async function visible(role: 'panel' | 'companion'): Promise<boolean> {
  return app!.evaluate(
    ({ BrowserWindow }, target) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().includes(`window=${target}`))!
        .isVisible(),
    role,
  );
}
/** 摸摸的反应按熟悉度轮换（core/bond.ts），任一句都算对。 */
const petReaction =
  /有点痒|摸我干嘛|谢谢啊|嘿嘿|再摸一下也行|收到你的摸摸啦|心情不错|老一套|想我了|随你摸|记得干活|毛都秃了|收费了|摸鱼/;

/** 模拟实验室默认藏着：先在「偏好与边界」打开，再进去。 */
async function openLab(panel: Page): Promise<void> {
  await expect(panel.getByRole('button', { name: '模拟实验室' })).toHaveCount(0);
  await panel.getByRole('button', { name: '偏好与边界' }).click();
  const toggle = panel.getByRole('checkbox', { name: /显示模拟实验室/ });
  await toggle.click();
  await expect(toggle).toBeChecked();
  await panel.getByRole('button', { name: '模拟实验室' }).click();
}

/**
 * 主动开口默认在测试里关掉：启动即「人来了」，上午跑测试会先亮一张早安卡，
 * A 就变成「接住提醒」而不是摸摸——结果随钟点变化。专门测提醒的用例显式打开。
 */
async function launch(options: { proactive?: boolean } = {}): Promise<{ panel: Page; pet: Page }> {
  await writeFile(
    join(directory, 'proactive-v1.json'),
    JSON.stringify({
      version: 1,
      config: {
        enabled: options.proactive === true,
        speak: false,
        // 早安/收工这类招呼始终关着：它们随时间点触发，放进测试只会带来随机性。
        groups: { work: true, reminder: true, ritual: false },
      },
      history: [],
    }),
    'utf8',
  );
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      key !== 'ELECTRON_RUN_AS_NODE' &&
      key !== 'XINBAN_DEV' &&
      key !== 'XINBAN_AI_TEST_KEY'
    )
      env[key] = value;
  env.XINBAN_DATA_DIR = directory;
  // 工作进度读的是本机 WorkBuddy 的会话记录：固定到临时目录，
  // 否则测试会看到开发者自己机器上的真实会话，结果随机。
  env.XINBAN_PROJECTS_DIR = join(directory, 'projects');
  // 同理：Claude Code / Codex 的记录也指到临时目录，测试绝不读开发者自己的会话。
  env.XINBAN_CLAUDE_DIR = join(directory, 'claude');
  env.XINBAN_CODEX_DIR = join(directory, 'codex');
  // 官方钩子会改 ~/.claude/settings.json 与 ~/.codex/config.toml：测试里一律指到临时目录，
  // 绝不碰开发者自己的配置。
  env.XINBAN_CLAUDE_HOME = join(directory, 'claude-home');
  env.XINBAN_CODEX_HOME = join(directory, 'codex-home');
  env.XINBAN_WORKBUDDY_HOME = join(directory, 'workbuddy-home');
  env.XINBAN_CODEBUDDY_HOME = join(directory, 'codebuddy-home');
  // 不拉起系统媒体桥：测试不该去按开发者电脑上的播放键。
  env.XINBAN_NO_MEDIA = '1';
  // 假的摄像头/麦克风：让「耳朵眼睛」这条链路能在没有真设备的机器上被真正跑通，
  // 而不是只验证开关存盘。假设备也走同一套权限处理器，所以权限断言仍然有效。
  app = await _electron.launch({
    args: [root, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    env,
  });
  app.on('window', (window) => window.on('pageerror', (error) => errors.push(error.message)));
  // 冷启动实测约 2–3 秒；机器繁忙时会更久，给 15 秒避免把环境抖动当成产品故障。
  await expect.poll(() => app!.windows().length, { timeout: 15_000 }).toBe(2);
  const windows = app.windows();
  for (const window of windows) await window.waitForURL(/window=(panel|companion)/);
  const panel = windows.find((window) => window.url().includes('window=panel'))!;
  const pet = windows.find((window) => window.url().includes('window=companion'))!;
  await expect(pet.getByTestId('screen-title')).toBeVisible();
  await expect(pet.locator('.pet-compact')).toBeVisible();
  await expect(pet.locator('.board')).toHaveCount(0);
  await expect(pet.locator('html')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(pet.locator('body')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  expect(
    await pet
      .locator('.device-screen')
      .evaluate((element) => element.getBoundingClientRect().bottom <= window.innerHeight),
  ).toBe(true);
  // 启动只显示桌面伙伴；控制面板收在托盘，由宠物上的按钮打开。
  await expect.poll(() => visible('panel')).toBe(false);
  await expect.poll(() => visible('companion')).toBe(true);
  await pet.getByRole('button', { name: '打开控制面板' }).click();
  await expect.poll(() => visible('panel')).toBe(true);
  await expect(panel.getByRole('heading', { name: '认真做事，也好好休息。' })).toBeVisible();
  return { panel, pet };
}

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xinban-e2e-'));
  errors.length = 0;
});
test.afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(directory, { recursive: true, force: true });
  expect(errors).toEqual([]);
});

test('actual desktop: synchronized sessions, todos, timer, simulation, settings and restart', async ({}, info) => {
  let { panel, pet } = await launch();
  await panel.getByRole('button', { name: '编码', exact: true }).click();
  await expect(pet.locator('.screen-detail')).toHaveText('编码');
  await panel.getByLabel('新待办').fill('完成第一个桌面原型');
  await panel.getByRole('button', { name: '添加待办' }).click();
  await expect(panel.getByRole('checkbox', { name: '完成第一个桌面原型' })).toBeVisible();
  await panel.getByRole('button', { name: '开始专注' }).click();
  await panel.getByRole('button', { name: '暂停计时' }).click();
  await expect(pet.getByTestId('screen-title')).toHaveText('稍停一下也没关系');
  await panel.screenshot({ path: info.outputPath('01-control-panel.png'), fullPage: true });
  await pet.screenshot({ path: info.outputPath('02-companion.png'), omitBackground: true });
  const security = await panel.evaluate(() => ({
    node: typeof Reflect.get(window, 'require'),
    process: typeof Reflect.get(window, 'process'),
    bridge: Object.keys(window.companion ?? {}).sort(),
  }));
  expect(security.node).toBe('undefined');
  expect(security.process).toBe('undefined');
  expect(security.bridge).toEqual([
    'aiCancel',
    'aiClear',
    'aiConfigure',
    'aiSend',
    'aiSession',
    'aiStatus',
    'approvalsEnable',
    'approvalsRevoke',
    'approvalsState',
    'attachPaths',
    'attachPick',
    'clearData',
    'confirmAnswer',
    'confirmExternal',
    'confirmState',
    'delegateCancel',
    'delegateProbe',
    'delegateSave',
    'delegateState',
    'deviceRefresh',
    'deviceSave',
    'deviceSimPress',
    'deviceState',
    'dispatch',
    'exportData',
    'exportMapping',
    'exportReplay',
    'filesAdd',
    'filesRemove',
    'filesState',
    'filesUndo',
    'filesWritable',
    'health',
    'healthOpenLogs',
    'hooksApply',
    'hooksConsent',
    'hooksRepair',
    'hooksStatus',
    'hooksWatchState',
    'importData',
    'importReplay',
    'iotSave',
    'iotSet',
    'lanScanStart',
    'lanScanState',
    'mcpEnable',
    'mcpImport',
    'mcpRemove',
    'mcpRestart',
    'mcpSave',
    'mcpState',
    'mcpToolTrust',
    'mcpTrust',
    'memoryClear',
    'memoryEnable',
    'memoryRemove',
    'memoryState',
    'memoryTidyApply',
    'memoryTidyDiscard',
    'memoryTidyStart',
    'memoryTidyState',
    'memoryTidyUndo',
    'mousePassthrough',
    'musicControl',
    'musicRefresh',
    'musicState',
    'onAiSession',
    'onCaptureFrame',
    'onConfirmState',
    'onDelegateState',
    'onDeviceState',
    'onFiles',
    'onHealth',
    'onHooksWatch',
    'onLanScan',
    'onMcp',
    'onMemoryState',
    'onMemoryTidyState',
    'onMusicState',
    'onPersonaState',
    'onProactiveState',
    'onSensesState',
    'onSttState',
    'onTtsState',
    'onVisionState',
    'onVoiceState',
    'onWorkState',
    'onWorkbench',
    'openExternal',
    'pathForFile',
    'personaSave',
    'personaState',
    'phonePushSave',
    'phonePushState',
    'phonePushTest',
    'proactiveAnswer',
    'proactiveSave',
    'proactiveState',
    'remoteApproveSave',
    'remoteApproveState',
    'sendCameraFrame',
    'sensesReport',
    'sensesSave',
    'sensesState',
    'snapshot',
    'sttClearKey',
    'sttSave',
    'sttSaveKey',
    'sttState',
    'sttStop',
    'sttTranscribe',
    'subscribe',
    'ttsSpeak',
    'ttsState',
    'ttsStop',
    'usageState',
    'visionLook',
    'visionSave',
    'visionState',
    'voiceSave',
    'voiceState',
    'windowAction',
    'workRefresh',
    'workSourcesSave',
    'workState',
    'workbenchDiff',
    'workbenchEditor',
    'workbenchOpen',
    'workbenchReview',
    'workbenchSeen',
    'workbenchState',
  ]);
  const invalid = await panel.evaluate(async () =>
    window.companion!.dispatch(JSON.parse('{"type":"shell","command":"whoami"}')),
  );
  expect(invalid.ok).toBe(false);

  // 附件与授权目录：文件复制进沙盒 uploads/；桌宠窗口加不了目录（只收面板）。
  const sample = join(directory, 'note.md');
  await writeFile(sample, '# 笔记', 'utf8');
  const staged = await pet.evaluate((path) => window.companion!.attachPaths([path]), sample);
  expect(staged.ok && staged.items[0]!.rel).toMatch(/^uploads\/.+-note\.md$/);
  // 不能放在数据目录里：那里本身就是禁区。
  const notes = await mkdtemp(join(tmpdir(), 'xinban-e2e-notes-'));
  const fromPet = await pet
    .evaluate((path) => window.companion!.filesAdd(path, false), notes)
    .catch(() => null);
  expect(fromPet?.ok ?? false).toBe(false);
  const added = await panel.evaluate((path) => window.companion!.filesAdd(path, false), notes);
  expect(added).toEqual({ ok: true });
  await rm(notes, { recursive: true, force: true });

  await openLab(panel);
  await panel.getByRole('button', { name: '新建模拟任务' }).click();
  await expect(pet.getByTestId('screen-title')).toHaveText('正在进行中');
  await expect(pet.locator('.screen-detail')).not.toContainText('%');
  await panel.getByRole('button', { name: '重发重复事件' }).click();
  await expect(panel.locator('.journal')).toContainText('已忽略重复事件');
  await panel.getByRole('button', { name: '发送过期事件' }).click();
  await expect(panel.locator('.journal')).toContainText('已忽略乱序');
  await panel.getByRole('button', { name: '等待确认', exact: true }).click();
  await expect(pet.getByTestId('screen-title')).toHaveText('等你确认一下');
  await panel.getByRole('button', { name: '断开模拟连接' }).click();
  await expect(pet.getByTestId('screen-title')).toHaveText('模拟连接已断开');
  await panel.getByRole('button', { name: '恢复模拟连接' }).click();
  await expect(pet.getByTestId('screen-title')).toHaveText('稍停一下也没关系');
  await panel.getByRole('button', { name: '新建模拟任务' }).click();
  await panel.getByRole('button', { name: '已完成', exact: true }).click();
  await expect(pet.getByTestId('screen-title')).toHaveText('任务顺利完成');
  await panel.screenshot({ path: info.outputPath('03-simulator.png'), fullPage: true });

  await panel.getByRole('button', { name: '偏好与边界' }).click();
  // Checkboxes reflect the durable snapshot, not an optimistic local toggle.
  for (const name of [/减少动画/, /勿扰模式/, /伙伴窗口置顶/]) {
    const checkbox = panel.getByRole('checkbox', { name });
    await checkbox.click();
    await expect(checkbox).toBeChecked();
  }
  await expect(pet.getByTestId('device')).toHaveClass(/reduced/);
  await expect
    .poll(() =>
      app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL().includes('window=companion'))!
          .isAlwaysOnTop(),
      ),
    )
    .toBe(true);
  await panel.getByRole('checkbox', { name: /伙伴窗口置顶/ }).click();
  await expect(panel.getByRole('checkbox', { name: /伙伴窗口置顶/ })).not.toBeChecked();
  await pet.getByRole('button', { name: '隐藏伙伴' }).click();
  await panel.getByRole('button', { name: '显示桌面伙伴' }).click();
  await expect
    .poll(() =>
      app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL().includes('window=companion'))!
          .isVisible(),
      ),
    )
    .toBe(true);

  await app!.close();
  app = undefined;
  const saved = JSON.parse(await readFile(join(directory, 'state-v1.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  expect(saved).not.toHaveProperty('simulation');
  expect(saved).not.toHaveProperty('petUntil');
  ({ panel, pet } = await launch());
  await expect(panel.getByRole('checkbox', { name: '完成第一个桌面原型' })).toBeVisible();
  await expect(pet.getByTestId('screen-title')).toHaveText('稍停一下也没关系');
  await panel.getByRole('button', { name: '结束计时' }).click();
  await pet.getByRole('button', { name: 'A 互动按钮' }).click();
  await expect(pet.getByTestId('screen-title')).toHaveText(petReaction);
  await pet.getByRole('button', { name: 'B 游戏按钮' }).click();
  await expect(pet.locator('.game-screen')).toContainText('等圆点亮起');
  await expect(pet.locator('.game-screen')).toContainText('现在按 A', { timeout: 5_000 });
  await pet.getByRole('button', { name: 'A 互动按钮' }).click();
  await expect(pet.locator('.game-screen')).toContainText('反应时间');
  await pet.getByRole('button', { name: 'B 游戏按钮' }).click();
  await panel.getByRole('button', { name: '删除待办：完成第一个桌面原型' }).click();
  await panel.getByRole('button', { name: '取消', exact: true }).click();
  await expect(panel.getByRole('checkbox', { name: '完成第一个桌面原型' })).toBeVisible();
});

test('running timer requires explicit recovery after launch', async () => {
  const now = Date.now();
  const state = reduce(
    initialState(now),
    { type: 'timer.start', minutes: 25 },
    { now, id: 'recovery-test' },
  );
  await writeFile(resolve(directory, 'state-v1.json'), JSON.stringify(durableState(state)), 'utf8');
  const { panel, pet } = await launch();
  await expect(pet.getByTestId('screen-title')).toHaveText('计时等待恢复');
  await panel.getByRole('button', { name: '继续计时' }).click();
  await expect(pet.getByTestId('screen-title')).toHaveText('我陪你，慢慢来');
});

test('focus timer can be paused, resumed and ended on the small screen', async () => {
  const { panel, pet } = await launch();
  await panel.getByRole('button', { name: '开始专注' }).click();
  const timer = pet.getByTestId('screen-timer');
  await expect(timer).toContainText('专注中');
  await timer.click();
  await expect(timer).toContainText('已暂停');
  await expect(panel.getByRole('button', { name: '继续计时' })).toBeVisible();
  await timer.click();
  await expect(timer).toContainText('专注中');
  await timer.click();
  await expect(timer).toContainText('已暂停');
  await pet.getByTestId('screen-timer-end').click();
  await expect(pet.getByTestId('screen-timer')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '开始专注' })).toBeVisible();
});

test('F-03 input mapping: short press, long press and unassigned gesture', async () => {
  const { pet } = await launch();
  const a = pet.getByRole('button', { name: 'A 互动按钮' });
  const b = pet.getByRole('button', { name: 'B 游戏按钮' });

  await a.click();
  await expect(pet.getByTestId('screen-title')).toHaveText(petReaction);

  // 长按 B 只应切换勿扰；不得补发短按而启动反应游戏。
  await b.click({ delay: 950 });
  await expect(pet.getByTestId('input-feedback')).toContainText('已开启勿扰');
  await expect(pet.locator('.screen-top')).toContainText('勿扰');
  await expect(pet.locator('.game-screen')).toHaveCount(0);
  // 屏上右上角点一下就关掉勿扰，再点一下又开。
  await pet.getByTestId('screen-quiet').click();
  await expect(pet.getByTestId('screen-quiet')).not.toContainText('勿扰');
  await expect(pet.getByTestId('screen-quiet')).toHaveAttribute('aria-pressed', 'false');
  await pet.getByTestId('screen-quiet').click();
  await expect(pet.getByTestId('screen-quiet')).toContainText('勿扰');

  // A 长按未分配：不产生业务动作，也不伪装成一次短按。
  await a.click({ delay: 950 });
  await expect(pet.getByTestId('input-feedback')).toContainText('暂未分配');
  await expect(pet.locator('.game-screen')).toHaveCount(0);
});

test('AI panel requires explicit configuration and never leaks a key', async ({}, info) => {
  const { panel } = await launch();
  await panel.getByRole('button', { name: '问问伙伴' }).click();
  await expect(panel.getByRole('heading', { name: '问问伙伴，也说给自己听。' })).toBeVisible();
  await expect(panel.getByText('未配置', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '发送' })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '保存配置' })).toBeDisabled();
  await expect(panel.getByTestId('ai-log')).toContainText('还没有对话');
  await expect(panel.locator('.ai-notice')).not.toContainText('sk-');
  await expect(panel.locator('.ai-notice')).toContainText('相关记忆');
  await expect(panel.locator('.ai-notice')).toContainText('不等同于文件目录沙盒');
  await expect(panel.locator('footer')).toContainText(`芯伴 ${appVersion}`);

  // 只用明显的假 Key 验证保存／清除流程；本测试不发起任何真实云请求。
  await panel.getByLabel('API Key', { exact: true }).fill('sk-test-placeholder-not-a-real-key');
  await panel.getByRole('button', { name: '保存配置' }).click();
  await expect(panel.getByText('已配置', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('API Key', { exact: true })).toHaveValue('');
  await expect(panel.locator('.ai-notice')).not.toContainText('sk-');
  await panel.screenshot({ path: info.outputPath('05-ai-panel.png'), fullPage: true });

  await panel.getByRole('button', { name: '清除本机 Key' }).click();
  await panel.getByRole('button', { name: '确认清除 Key' }).click();
  await expect(panel.getByText('未配置', { exact: true })).toBeVisible();
});

test('companion window owns the conversation: compose, send, and report failure', async () => {
  const { pet } = await launch();
  // 桌宠屏幕默认是表情，不是对话。
  await expect(pet.getByTestId('screen-title')).toBeVisible();
  // 表情要能自报情绪：弯眼和竖眼的区别，读屏用户看不见。
  await expect(pet.getByRole('img', { name: /伙伴表情/ })).toBeVisible();
  await pet.getByRole('button', { name: '和伙伴说句话' }).click();
  const composer = pet.getByLabel('给伙伴的消息');
  await expect(composer).toBeVisible();
  await composer.fill('你好呀');
  await pet.getByRole('button', { name: '发送' }).click();

  // 未配置 Key 时主进程直接拒绝：桌宠必须把原因说出来，不能沉默或假装正在回复。
  const thread = pet.getByTestId('pet-ai-thread');
  await expect(thread).toBeVisible();
  // 对话模式里脸也必须在。表情系统十种脸谱都做了，但之前一进对话就把整块屏
  // 换成线程——聊天时一张脸都看不见，体感就是「表情多样化没做」。
  const chatFace = pet.getByTestId('pet-ai-face');
  await expect(chatFace).toBeVisible();
  await expect(chatFace.getByRole('img', { name: /伙伴表情/ })).toBeVisible();
  await expect(thread.locator('.ai-error')).toContainText('尚未配置');
  await expect(pet.getByTestId('pet-ai-answer')).toHaveCount(0);
  await expect(thread).not.toContainText('正在回复');

  // 多轮：输入行是常驻的，发完一轮不用「收起 → 说话」再点两次才能问下一句。
  await expect(composer).toBeVisible();
  await expect(pet.getByTestId('pet-mic')).toHaveCount(0);

  // 收起后回到表情，而不是把屏幕永久占在对话上。
  await pet.getByRole('button', { name: '结束对话' }).click();
  await expect(pet.getByTestId('screen-title')).toBeVisible();
  await expect(pet.getByTestId('pet-ai-thread')).toHaveCount(0);
});

test('companion window remembers its position across restarts', async () => {
  await launch();
  const initial = await app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().includes('window=companion'))!
      .getBounds(),
  );
  await app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().includes('window=companion'))!
      .setPosition(120, 140),
  );
  await expect
    .poll(
      async () => {
        const raw = await readFile(join(directory, 'window-bounds-v1.json'), 'utf8').catch(
          () => '',
        );
        return raw.includes('"x":120') && raw.includes('"y":140');
      },
      { timeout: 5_000 },
    )
    .toBe(true);
  await app!.close();
  app = undefined;
  await launch();
  const bounds = await app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().includes('window=companion'))!
      .getBounds(),
  );
  expect(bounds.x).toBe(120);
  expect(bounds.y).toBe(140);
  // Windows 会给透明窗口补边框像素；尺寸以「与首次启动一致」验证，不硬编码。
  expect(bounds.width).toBe(initial.width);
  expect(bounds.height).toBe(initial.height);
  expect(bounds.width).toBeLessThan(300);
  expect(bounds.height).toBeLessThan(400);
});

test('transparent pet margins pass mouse events through', async () => {
  const { pet } = await launch();
  await pet.mouse.move(2, 2);
  await expect
    .poll(() => pet.locator('body').getAttribute('data-passthrough'), { timeout: 3_000 })
    .toBe('true');
  await pet.mouse.move(132, 130);
  await expect
    .poll(() => pet.locator('body').getAttribute('data-passthrough'), { timeout: 3_000 })
    .toBe('false');
});

test('damaged data stays intact and prevents misleading saves', async () => {
  const raw = '{broken storage';
  await writeFile(join(directory, 'state-v1.json'), raw, 'utf8');
  const { panel } = await launch();
  await expect(panel.getByRole('alert')).toContainText('只读安全模式');
  await panel.getByLabel('新待办').fill('不应写入');
  await panel.getByRole('button', { name: '添加待办' }).click();
  await expect(panel.getByRole('alert')).toContainText('只读安全模式');
  await expect(panel.getByRole('checkbox', { name: '不应写入' })).toHaveCount(0);
  expect(await readFile(join(directory, 'state-v1.json'), 'utf8')).toBe(raw);
});

test('A short press acknowledges a waiting simulation task', async () => {
  const { panel, pet } = await launch();
  await openLab(panel);
  await panel.getByRole('button', { name: '新建模拟任务' }).click();
  await panel.getByRole('button', { name: '等待确认', exact: true }).click();
  await expect(pet.getByTestId('screen-title')).toHaveText('等你确认一下');
  await pet.getByRole('button', { name: 'A 互动按钮' }).click();
  await expect(pet.getByTestId('screen-title')).toHaveText('正在进行中');
  await expect(panel.locator('.journal')).toContainText('已确认继续');
  await expect(panel.getByRole('button', { name: '确认此提示' })).toHaveCount(0);
});

test('file dialogs export mapping, replay and personal data, then re-import them', async () => {
  const { panel } = await launch();
  const savePath = join(directory, 'export.json');
  const openPath = join(directory, 'import.json');
  await app!.evaluate(
    ({ dialog }, paths: { save: string; open: string }) => {
      // 原生对话框无法用 CDP 点击，测试内替换为主进程侧的固定响应。
      const mutable = dialog as unknown as {
        showSaveDialog: unknown;
        showOpenDialog: unknown;
        showMessageBox: unknown;
      };
      mutable.showSaveDialog = async () => ({ canceled: false, filePath: paths.save });
      mutable.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.open] });
      mutable.showMessageBox = async () => ({ response: 1 });
    },
    { save: savePath, open: openPath },
  );

  await openLab(panel);
  await panel.getByRole('button', { name: '导出映射表 JSON' }).click();
  const mapping = JSON.parse(await readFile(savePath, 'utf8')) as Record<string, unknown>;
  expect(mapping.kind).toBe('xinban-input-mapping');
  expect(mapping).not.toHaveProperty('todos');

  await panel.getByRole('button', { name: '新建模拟任务' }).click();
  await expect(panel.locator('.task-list li')).toHaveCount(1);
  await panel.getByRole('button', { name: '导出回放脚本' }).click();
  const replay = JSON.parse(await readFile(savePath, 'utf8')) as {
    kind: string;
    events: unknown[];
  };
  expect(replay.kind).toBe('xinban-replay-script');
  expect(replay.events.length).toBeGreaterThan(0);
  expect(replay).not.toHaveProperty('todos');

  await writeFile(openPath, JSON.stringify(replay), 'utf8');
  await panel.getByRole('button', { name: '导入并回放' }).click();
  await expect(panel.getByRole('status').filter({ hasText: '已按原规则回放' })).toBeVisible();
  await expect(panel.locator('.journal')).toContainText('已忽略重复事件');

  await panel.getByRole('button', { name: '偏好与边界' }).click();
  await panel.getByRole('button', { name: '导出个人数据' }).click();
  const personal = JSON.parse(await readFile(savePath, 'utf8')) as Record<string, unknown>;
  expect(personal.version).toBe(1);
  expect(personal).not.toHaveProperty('simulation');
  await writeFile(openPath, JSON.stringify(personal), 'utf8');
  await panel.getByRole('button', { name: '导入个人数据…' }).click();
  await expect(panel.getByRole('status').filter({ hasText: '个人数据已导入' })).toBeVisible();
});

// 真实云调用：只有显式注入 XINBAN_AI_TEST_KEY 才运行，默认套件不产生费用。
test('real DeepSeek round trip goes through the application IPC', async ({}, info) => {
  const key = process.env.XINBAN_AI_TEST_KEY;
  test.skip(!key, '未设置 XINBAN_AI_TEST_KEY，跳过真实云调用');
  test.setTimeout(90_000);
  const { panel, pet } = await launch();
  await panel.getByRole('button', { name: '问问伙伴' }).click();
  await panel.getByLabel('API Key', { exact: true }).fill(key!);
  await panel.getByRole('button', { name: '保存配置' }).click();
  await expect(panel.getByText('已配置', { exact: true })).toBeVisible();
  await panel.getByLabel('给伙伴的消息').fill('只回复两个字：你好');
  // 直接记录主进程推来的会话快照：回复太快时「正在回复」气泡只存在几十毫秒，用 DOM 轮询不可靠。
  await panel.evaluate(() => {
    const probe = window as unknown as { __streams: string[] };
    probe.__streams = [];
    window.companion!.onAiSession((state) => {
      if (state.streaming !== '') probe.__streams.push(state.streaming);
    });
  });
  await panel.getByRole('button', { name: '发送' }).click();
  await expect(panel.locator('.ai-bubble.assistant:not(.streaming)')).toBeVisible({
    timeout: 40_000,
  });
  const streams = await panel.evaluate(
    () => (window as unknown as { __streams: string[] }).__streams,
  );
  expect(streams.length).toBeGreaterThan(0);
  const reply = (
    await panel.locator('.ai-bubble.assistant').last().locator('span').innerText()
  ).trim();
  // 每个流式快照都必须是最终正文的真前缀：丢字、重复或乱序都会破坏这个关系。
  // 不假设快照条数——主进程会合并 50ms 内的增量，短回复合成一次是正常的。
  for (const snapshot of streams) expect(reply.startsWith(snapshot.trim())).toBe(true);
  // 收尾后不应残留半截气泡。
  await expect(panel.getByTestId('ai-streaming')).toHaveCount(0);
  await expect(panel.getByText(/[1-3] 次模型请求/)).toBeVisible();
  await expect(panel.locator('body')).not.toContainText(key!);

  // 面板里提问，桌宠小屏也要开口：这是「回复没显示在屏幕上」的核心回归点。
  await expect(pet.getByTestId('pet-ai-thread')).toBeVisible();
  await expect(pet.getByTestId('pet-ai-answer')).toContainText(reply);
  await pet.screenshot({ path: info.outputPath('07-companion-reply.png'), omitBackground: true });
});

test('real DeepSeek agent searches the web and shows its sources', async ({}, info) => {
  const key = process.env.XINBAN_AI_TEST_KEY;
  test.skip(!key, '未设置 XINBAN_AI_TEST_KEY，跳过真实云调用');
  // 一次真实来回包含：模型请求 → 搜索 → 回填 → 第二次模型请求。
  test.setTimeout(150_000);
  const { panel, pet } = await launch();
  await panel.getByRole('button', { name: '问问伙伴' }).click();
  await panel.getByLabel('API Key', { exact: true }).fill(key!);
  await panel.getByRole('button', { name: '保存配置' }).click();
  await expect(panel.getByText('已配置', { exact: true })).toBeVisible();

  await panel.getByLabel('给伙伴的消息').fill('查一下长沙明天的天气，只回答天气和气温');
  await panel.getByRole('button', { name: '发送' }).click();

  // 工具轨迹证明它真的去查了，而不是凭记忆编一段天气。
  await expect(panel.getByTestId('ai-trace')).toBeVisible({ timeout: 120_000 });
  await expect(panel.getByTestId('trace-web_search').first()).toContainText('搜索：');
  // 等这一轮真正结束（气泡不再 streaming）：来源是在落定时才随回复一起给出的。
  await expect(panel.locator('.ai-bubble.assistant:not(.streaming)')).toBeVisible({
    timeout: 120_000,
  });
  // 来源必须可追溯：至少一条真实链接。
  await expect(panel.getByTestId('ai-citations')).toBeVisible();
  expect(await panel.getByTestId('ai-citations').locator('button').count()).toBeGreaterThan(0);

  const reply = (
    await panel.locator('.ai-bubble.assistant').last().locator('span').innerText()
  ).trim();
  expect(reply.length).toBeGreaterThan(10);
  expect(reply).not.toContain('无法联网');
  // 旧版提示词会让模型说「我查不到」；这里确认那条限制已经解除。
  expect(reply).not.toContain('没有联网能力');

  // 桌宠小屏同步显示同一段回复（可能被 216px 宽的小屏截断，只校验非空且有内容）。
  await expect(pet.getByTestId('pet-ai-answer')).toHaveText(/.{8,}/);
  await panel.screenshot({ path: info.outputPath('08-agent-search.png'), fullPage: true });
});

test('work progress: reads a local WorkBuddy session and shows it on the small screen', async () => {
  const project = join(directory, 'projects', 'demo');
  await mkdir(project, { recursive: true });
  const at = Date.now();
  const lines = [
    JSON.stringify({
      type: 'ai-title',
      aiTitle: '给桌宠加工作感知',
      cwd: '/work/ai-desktop-companion',
    }),
    JSON.stringify({
      type: 'message',
      role: 'user',
      timestamp: at - 4_000,
      sessionId: 'abc',
      cwd: '/work/ai-desktop-companion',
      content: [{ type: 'input_text', text: '<user_query>把进度接到小屏</user_query>' }],
    }),
    JSON.stringify({
      type: 'function_call',
      name: 'Bash',
      callId: 'c1',
      arguments: '{"command":"npm run build"}',
      timestamp: at - 2_000,
      sessionId: 'abc',
    }),
    JSON.stringify({
      type: 'function_call_result',
      callId: 'c1',
      status: 'completed',
      timestamp: at - 1_500,
    }),
  ].join('\n');
  await writeFile(join(project, 'abc.jsonl'), lines, 'utf8');

  const { panel, pet } = await launch();
  // 小屏：正在干活时挤出一条进度，不能把表情和计时表挤掉。
  await expect(pet.getByTestId('screen-work')).toBeVisible();
  await expect(pet.getByTestId('screen-work')).toContainText('ai-desktop-companion');
  await expect(pet.getByTestId('screen-title')).toBeVisible();
  // 点进度那一行：就在小屏上展开工作台，不用去面板。
  await pet.getByTestId('screen-work').click();
  await expect(pet.getByTestId('pet-bench')).toBeVisible();
  await expect(pet.getByTestId('pet-bench-item').first()).toContainText('ai-desktop-companion');
  await pet.getByTestId('pet-bench-item').first().click();
  await expect(pet.getByTestId('pet-result')).toBeVisible();
  await pet.getByRole('button', { name: '返回列表' }).click();
  await pet.getByRole('button', { name: '← 收起' }).click();
  await expect(pet.getByTestId('pet-bench')).toHaveCount(0);
  await expect(pet.getByTestId('screen-title')).toBeVisible();

  await panel.getByRole('button', { name: '问问伙伴' }).click();
  const card = panel.getByTestId('ai-work');
  await expect(card.getByTestId('work-session')).toHaveCount(1);
  await expect(card).toContainText('给桌宠加工作感知');
  await expect(card).toContainText('跑命令：npm run build');
  await expect(card).toContainText('把进度接到小屏');
});

test('todos: the small screen shows the next open item and can be ticked off there', async ({}, info) => {
  const { panel, pet } = await launch();
  // 没待办时不该凭空多占一行——屏脚只在有内容时出现。
  await expect(pet.getByTestId('screen-todo')).toHaveCount(0);
  await expect(pet.getByTestId('screen-detail')).toContainText('不用着急');

  for (const title of ['写完立项指南说明', '回复代理商邮件']) {
    await panel.getByLabel('新待办').fill(title);
    await panel.getByRole('button', { name: '添加待办' }).click();
    await expect(panel.getByRole('checkbox', { name: title })).toBeVisible();
  }

  const todo = pet.getByTestId('screen-todo');
  // 列表最新的一条在最上面，就显示它；剩下的用 +1 交代，不把 216px 铺成清单。
  await expect(todo).toContainText('回复代理商邮件');
  await expect(todo).toContainText('+1');
  // 216px 是硬边界：挤进来两行屏脚也不能把屏幕撑出滚动。
  expect(
    await pet
      .locator('.device-screen')
      .evaluate((element) => element.scrollHeight - element.clientHeight),
  ).toBeLessThanOrEqual(1);
  await pet.screenshot({ path: info.outputPath('09-companion-todo.png'), omitBackground: true });
  // 面板里的装配预览共享同一份状态，240px 那版也得显示且不能溢出。
  await expect(panel.getByTestId('screen-todo')).toContainText('回复代理商邮件');
  expect(
    await panel
      .locator('.device-screen')
      .evaluate((element) => element.scrollHeight - element.clientHeight),
  ).toBeLessThanOrEqual(1);
  await panel
    .locator('.device-stage')
    .screenshot({ path: info.outputPath('10-panel-preview-todo.png') });

  // 在桌宠上直接划掉，面板里的勾选跟着变。
  await todo.click();
  await expect(todo).toContainText('写完立项指南说明');
  await expect(todo).not.toContainText('+');
  await expect(panel.getByRole('checkbox', { name: '回复代理商邮件' })).toBeChecked();

  // 全部做完之后屏脚让位，副标题改成结算语，而不是挂一行空的。
  await todo.click();
  await expect(pet.getByTestId('screen-todo')).toHaveCount(0);
  await expect(pet.getByTestId('screen-detail')).toContainText('都做完了');
});

test('persona: switching the temper is saved to disk and survives a restart', async ({}, info) => {
  const { panel, pet } = await launch();
  await panel.getByRole('button', { name: '问问伙伴' }).click();
  const card = panel.getByTestId('ai-persona');
  await expect(card).toContainText('损友');
  await expect(card.getByTestId('persona-banter')).toHaveAttribute('aria-checked', 'true');

  await card.getByTestId('persona-dry').click();
  await expect(card.getByTestId('persona-dry')).toHaveAttribute('aria-checked', 'true');
  await card.getByLabel('它怎么叫你').fill('阿超');
  await card.getByLabel('屏幕闲时标语').fill('慢慢来\n我在呢');
  await card.getByRole('button', { name: '保存性格与标语' }).click();
  await expect(card).toContainText('已保存');

  // 存完立刻上屏：不用重启，也不用再点一次。
  await expect(pet.getByTestId('screen-title')).toHaveText(/^(慢慢来|我在呢)$/);
  await card.screenshot({ path: info.outputPath('11-persona-card.png') });
  await pet.screenshot({ path: info.outputPath('12-companion-slogan.png'), omitBackground: true });

  // 表情卡：换画风、关掉一种，桌宠马上换画法；性格那几项不被覆盖。
  const faces = panel.getByTestId('face-card');
  await expect(faces.getByTestId('face-grid').locator('li')).toHaveCount(12);
  await faces.getByLabel('表情画风').selectOption('pixel');
  await faces.getByLabel('启用表情 有点担心').click();
  await expect(faces.getByLabel('启用表情 有点担心')).not.toBeChecked();
  await expect(pet.locator('svg.face-pixel').first()).toBeVisible();
  await faces.screenshot({ path: info.outputPath('13-face-card.png') });

  // 落盘要能被人眼核对：四个字段 + 版本号，不多不少。
  expect(JSON.parse(await readFile(join(directory, 'persona-v1.json'), 'utf8'))).toEqual({
    version: 1,
    preset: 'dry',
    nickname: '阿超',
    idleLines: ['慢慢来', '我在呢'],
    face: { style: 'pixel', off: ['sad'], followChat: true },
  });

  await app!.close();
  app = undefined;
  const restarted = await launch();
  await restarted.panel.getByRole('button', { name: '问问伙伴' }).click();
  await expect(restarted.panel.getByTestId('ai-persona')).toContainText('惜字');
  await expect(restarted.panel.getByTestId('persona-dry')).toHaveAttribute('aria-checked', 'true');
  await expect(restarted.panel.getByLabel('它怎么叫你')).toHaveValue('阿超');
  await expect(restarted.pet.getByTestId('screen-title')).toHaveText(/^(慢慢来|我在呢)$/);
  await expect(restarted.pet.locator('svg.face-pixel').first()).toBeVisible();
});

test('memory: seeded facts reach the panel, can be forgotten and switched off', async () => {
  const seeded = {
    version: 1,
    enabled: true,
    facts: [
      {
        id: 'f1',
        text: '不吃香菜',
        category: 'preference',
        source: 'said',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        hits: 0,
        pinned: false,
      },
      {
        id: 'f2',
        text: '在长沙做医院信息化工作',
        category: 'identity',
        source: 'inferred',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        hits: 0,
        pinned: false,
      },
    ],
    episodes: [{ id: 'e1', at: Date.now(), summary: '聊了把项目改成个人 agent' }],
  };
  await writeFile(join(directory, 'memory-v1.json'), JSON.stringify(seeded), 'utf8');

  const { panel } = await launch();
  await panel.getByRole('button', { name: '问问伙伴' }).click();
  const card = panel.getByTestId('ai-memory');
  await expect(card.getByTestId('memory-fact')).toHaveCount(2);
  await expect(card.getByText('不吃香菜')).toBeVisible();
  // 情节记忆也要显示：用户得知道它「记得哪次聊天」。
  await expect(card.getByText('聊了把项目改成个人 agent')).toBeVisible();

  // 整理入口走通整条 IPC；条数太少时本地就拦下，不会发请求。
  const tidy = card.getByTestId('memory-tidy');
  await tidy.getByRole('button', { name: '整理记忆' }).click();
  await expect(tidy).toContainText('才 2 条，不用整理。');
  await expect(tidy.getByRole('button', { name: '撤销上次整理' })).toHaveCount(0);

  const readMemory = async (): Promise<{ enabled: boolean; facts: { text: string }[] }> =>
    JSON.parse(await readFile(join(directory, 'memory-v1.json'), 'utf8')) as {
      enabled: boolean;
      facts: { text: string }[];
    };

  await card.getByRole('button', { name: '忘记：不吃香菜' }).click();
  await expect(card.getByTestId('memory-fact')).toHaveCount(1);
  // 删除必须落盘，不能只是界面上消失。
  // 界面是乐观更新：条目立刻消失，写盘是异步 IPC。所以这里等文件，不等界面。
  await expect
    .poll(async () => (await readMemory()).facts.map((fact) => fact.text), { timeout: 5_000 })
    .toEqual(['在长沙做医院信息化工作']);

  await card.getByLabel('启用长期记忆').uncheck();
  await expect(card.getByText('已关闭')).toBeVisible();
  await expect.poll(async () => (await readMemory()).enabled, { timeout: 5_000 }).toBe(false);
  // 关了记忆就不该再有整理入口。
  await expect(card.getByTestId('memory-tidy')).toHaveCount(0);

  // 关闭的是「继续记」，不是销毁：已有记忆仍然在文件里。
  expect((await readMemory()).facts).toHaveLength(1);
});

test('real DeepSeek agent remembers what you tell it, and uses it next turn', async ({}, info) => {
  const key = process.env.XINBAN_AI_TEST_KEY;
  test.skip(!key, '未设置 XINBAN_AI_TEST_KEY，跳过真实云调用');
  // 一轮回答 + 一轮后台抽取 + 一轮带记忆的回答。
  test.setTimeout(180_000);
  const { panel } = await launch();
  await panel.getByRole('button', { name: '问问伙伴' }).click();
  await panel.getByLabel('API Key', { exact: true }).fill(key!);
  await panel.getByRole('button', { name: '保存配置' }).click();
  await expect(panel.getByText('已配置', { exact: true })).toBeVisible();

  await panel
    .getByLabel('给伙伴的消息')
    .fill('记住这几件事：我叫林舟，在长沙做医院信息化，不吃香菜。');
  await panel.getByRole('button', { name: '发送' }).click();
  await expect(panel.locator('.ai-bubble.assistant:not(.streaming)')).toBeVisible({
    timeout: 60_000,
  });

  // 记忆是回复之后异步写的，这里等它落盘上屏。
  const facts = panel.getByTestId('ai-memory').getByTestId('memory-fact');
  await expect(facts.first()).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByTestId('ai-memory')).toContainText('香菜');

  // 第二问故意不提供任何信息：它只能从记忆里知道。
  await panel.getByLabel('给伙伴的消息').fill('我叫什么？不吃什么？');
  await panel.getByRole('button', { name: '发送' }).click();
  await expect(panel.locator('.ai-bubble.assistant').nth(1)).toBeVisible({ timeout: 60_000 });
  const reply = (
    await panel.locator('.ai-bubble.assistant').last().locator('span').innerText()
  ).trim();
  expect(reply).toContain('林舟');
  expect(reply).toContain('香菜');
  // 小屏约束：别写成一整篇。
  expect(reply.length).toBeLessThan(160);

  await panel.screenshot({ path: info.outputPath('09-memory.png'), fullPage: true });
});

test('senses: mic and camera are opt-in, feed the small screen, and survive a restart', async ({}, info) => {
  const { panel, pet } = await launch();
  await panel.getByRole('button', { name: '问问伙伴' }).click();
  const card = panel.getByTestId('ai-senses');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('sense-mic')).toHaveText('没开');
  await expect(card.getByTestId('sense-camera')).toHaveText('没开');
  // 没开的时候小屏不能声称在听：状态位仍然说自己是本地伙伴。
  await expect(pet.locator('.screen-top span').first()).toContainText('本地伙伴');

  // 假设备：真的走一遍 getUserMedia → 音量/帧差 → 上报 → 广播，而不是只存开关。
  // 超时给到 45s：全量连跑十几个 Electron 之后，Windows 上假摄像头的首次出帧
  // 会慢到 20s 以上——那是环境负载，不是被测行为，放宽等待比放宽断言诚实。
  await card.getByLabel('让它听见').check();
  await expect(card.getByTestId('sense-mic')).toHaveText('开着', { timeout: 45_000 });
  await card.getByLabel('让它看见').check();
  await expect(card.getByTestId('sense-camera')).toHaveText('开着', { timeout: 45_000 });

  // 采集在桌宠窗口，状态在面板：小屏的状态位要跟着变成「在听 · 在看」，
  // 这条断言跨了渲染进程 → 主进程 → 另一个渲染进程整条链路。
  await expect(pet.locator('.screen-top span').first()).toContainText('在听 · 在看', {
    timeout: 45_000,
  });
  await card.screenshot({ path: info.outputPath('13-senses-card.png') });
  await pet.screenshot({ path: info.outputPath('14-companion-senses.png'), omitBackground: true });

  expect(JSON.parse(await readFile(join(directory, 'senses-v1.json'), 'utf8'))).toEqual({
    version: 1,
    voice: false,
    ears: true,
    eyes: true,
  });

  await app!.close();
  app = undefined;
  const restarted = await launch();
  // 重启后不用再点一次：开关存在本机，采集自己就起来了。
  await expect(restarted.pet.locator('.screen-top span').first()).toContainText('在听 · 在看', {
    timeout: 45_000,
  });
  await restarted.panel.getByRole('button', { name: '问问伙伴' }).click();
  await expect(restarted.panel.getByTestId('ai-senses').getByTestId('sense-camera')).toHaveText(
    '开着',
    { timeout: 45_000 },
  );
});

test('speech: the mic button only appears when it can actually work, and the key stays encrypted', async ({}, info) => {
  const { panel, pet } = await launch();
  await panel.getByRole('button', { name: '问问伙伴' }).click();
  const card = panel.getByTestId('ai-stt');
  await expect(card).toBeVisible();

  // 默认没开。小屏上也不该有麦克风按钮——按下去只会换回一句「还没配好」。
  await expect(card.locator('.label')).toHaveText('没开');
  await pet.getByRole('button', { name: '和伙伴说句话' }).click();
  await expect(pet.getByTestId('pet-mic')).toHaveCount(0);

  await card.getByLabel('听懂我说话').check();
  // 文件是异步落盘的：第一次读可能还不存在，读不到就返回 null 让 poll 继续等。
  await expect
    .poll(async () => {
      try {
        return JSON.parse(await readFile(join(directory, 'stt-v1.json'), 'utf8'));
      } catch {
        return null;
      }
    })
    .toEqual({ version: 1, enabled: true });
  // 开了但没 Key：标签要说「缺 Key」，按钮仍然不出现。
  await expect(card.locator('.label')).toHaveText('缺 Key');
  await expect(pet.getByTestId('pet-mic')).toHaveCount(0);

  // 存一把假 Key：这里验证的不是能不能转，而是「能不能用」这件事被正确点亮。
  const key = 'sk-e2e-not-a-real-key-0000';
  await card.getByLabel('硅基流动 API Key').fill(key);
  await card.getByRole('button', { name: '保存 Key' }).click();
  await expect(card.locator('.label')).toHaveText('FunAudioLLM/SenseVoiceSmall');
  // 输入框存完就清空，Key 不该留在界面里。
  await expect(card.getByLabel('硅基流动 API Key')).toHaveValue('');

  // 落盘必须是密文：明文出现一次就算失败。
  const stored = await readFile(join(directory, 'stt-credentials-v1.json'), 'utf8');
  expect(stored).not.toContain(key);
  expect(stored).toContain('encryptedKey');

  // 现在按钮该出来了。
  const mic = pet.getByTestId('pet-mic');
  await expect(mic).toBeVisible();
  await mic.screenshot({ path: info.outputPath('15-mic-idle.png') });
  await card.screenshot({ path: info.outputPath('16-stt-card.png') });

  // 真的按一次：假麦克风 → MediaRecorder → IPC → 主进程。
  // 假 Key 一定转不出来，但**有没有回话**才是这条链路通没通的证据。
  await mic.dispatchEvent('pointerdown');
  await expect(mic).toContainText('s', { timeout: 5_000 });
  await pet.screenshot({ path: info.outputPath('17-mic-recording.png'), omitBackground: true });
  await mic.dispatchEvent('pointerup');
  await expect
    .poll(
      async () => {
        const state = await panel.evaluate(() => window.companion!.sttState());
        return state.lastText !== '' || state.lastError !== '';
      },
      { timeout: 40_000 },
    )
    .toBe(true);
  // 结果落回面板：不是静默失败，也不是假装成功。
  // 假 Key 会得到「Key 不对」，按太短会得到「太短」——两种都算这条链路活着。
  await expect(card.locator('.sense-error')).toBeVisible();

  await app!.close();
  app = undefined;
  const restarted = await launch();
  // 重启后不用再填一次：开关和 Key 都在本机，按钮自己就回来了。
  await restarted.pet.getByRole('button', { name: '和伙伴说句话' }).click();
  await expect(restarted.pet.getByTestId('pet-mic')).toBeVisible();
  await restarted.panel.getByRole('button', { name: '问问伙伴' }).click();
  await expect(restarted.panel.getByTestId('ai-stt').locator('.label')).toHaveText(
    'FunAudioLLM/SenseVoiceSmall',
  );
});

test('voice: 默认走云端自然人声，没 Key 回落系统语音，配置能存住', async ({}, info) => {
  const { panel } = await launch();
  await panel.getByRole('button', { name: '问问伙伴' }).click();
  const card = panel.getByTestId('ai-voice');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('voice-engine-cloud')).toHaveAttribute('aria-checked', 'true');
  await expect(card.locator('.label')).toHaveText('diana · 1.06×');
  // 这个环境没有填 Key：状态行要如实说「会用系统语音」，不能装作能合成。
  await expect(card.getByTestId('voice-resolved')).toContainText('缺 Key');

  // 替掉 speak，只验证我们送进去的是什么：文本被洗过、语言是中文、
  // 语速音调就是面板上那组——不是写死的 1.02。
  await panel.evaluate(() => {
    const calls: { text: string; lang: string; rate: number; pitch: number }[] = [];
    Reflect.set(window, '__spoken', calls);
    // The fake voice is not a Chromium native SpeechSynthesisVoice; mock its setter too.
    Object.defineProperty(SpeechSynthesisUtterance.prototype, 'voice', {
      configurable: true,
      get: () => null,
      set: () => undefined,
    });
    window.speechSynthesis.getVoices = () => [
      {
        voiceURI: 'test-local',
        name: 'Test Chinese',
        lang: 'zh-CN',
        localService: true,
        default: true,
      } as SpeechSynthesisVoice,
    ];
    window.speechSynthesis.dispatchEvent(new Event('voiceschanged'));
    window.speechSynthesis.speak = ((utterance: SpeechSynthesisUtterance) => {
      calls.push({
        text: utterance.text,
        lang: utterance.lang,
        rate: utterance.rate,
        pitch: utterance.pitch,
      });
    }) as typeof window.speechSynthesis.speak;
    window.speechSynthesis.cancel = () => undefined;
  });
  const spokenCount = (): Promise<number> =>
    panel.evaluate(() => (Reflect.get(window, '__spoken') as unknown[]).length);

  // 云端没有 Key 时点试听：应该当场用系统嗓子念出来，并把原因写在下面。
  // 「试听」的意义是听见，不是看见一条报错。
  await card.getByRole('button', { name: '试听这句' }).click();
  await expect(card.locator('p.muted').last()).toContainText('Key');
  await expect.poll(spokenCount).toBe(1);

  // 切回系统语音：音色下拉与音调滑杆只在这条路上有意义，云端没有音调旋钮。
  await card.getByTestId('voice-engine-system').click();
  await expect(card.locator('.label')).toHaveText('清亮 · 1.06×');
  await expect(card.getByLabel('系统音色')).toBeVisible();
  await expect(card.getByLabel('音调')).toBeVisible();

  await card.getByRole('button', { name: '试听这句' }).click();
  await expect.poll(spokenCount).toBe(2);
  await card.getByTestId('voice-pack-calm').click();
  await expect(card.locator('.label')).toHaveText('沉稳 · 0.90×');
  await card.getByRole('button', { name: '试听这句' }).click();
  await expect.poll(spokenCount).toBe(3);

  // 滑杆改完立刻反映在试听里，不用先保存：调音就该边调边听。
  await card.getByLabel('语速').evaluate((element: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, '1.2');
  await expect(card.locator('.label')).toHaveText('沉稳 · 1.20×');
  await card.getByRole('button', { name: '试听这句' }).click();
  await expect.poll(spokenCount).toBe(4);

  const spoken = await panel.evaluate(
    () =>
      Reflect.get(window, '__spoken') as {
        text: string;
        lang: string;
        rate: number;
        pitch: number;
      }[],
  );
  expect(spoken).toHaveLength(4);
  for (const call of spoken) {
    expect(call.text).toContain('我在呢');
    expect(call.lang).toBe('zh-CN');
  }
  // 第 0 条是云端回落，用的是当时的清亮参数；后面三条跟着面板走。
  expect(spoken[0]!.rate).toBeCloseTo(1.06);
  expect(spoken[1]!.rate).toBeCloseTo(1.06);
  expect(spoken[2]!.rate).toBeCloseTo(0.9);
  expect(spoken[2]!.pitch).toBeCloseTo(0.86);
  expect(spoken[3]!.rate).toBeCloseTo(1.2);
  await card.screenshot({ path: info.outputPath('18-voice-card.png') });
  // Native engines may throw synchronously or fail after starting: neither may claim success.
  await panel.evaluate(() => {
    window.speechSynthesis.speak = () => {
      throw new Error('fixed output failure');
    };
  });
  await card.getByRole('button', { name: '试听这句' }).click();
  await expect(card).toContainText('系统语音播放失败');
  await panel.evaluate(() => {
    window.speechSynthesis.speak = (utterance) => {
      setTimeout(() => utterance.dispatchEvent(new Event('error')), 10);
    };
  });
  await card.getByRole('button', { name: '试听这句' }).click();
  await expect(card).toContainText('系统语音播放失败');

  await card.getByRole('button', { name: '保存声音' }).click();
  await expect(card).toContainText('已保存');
  expect(JSON.parse(await readFile(join(directory, 'voice-v1.json'), 'utf8'))).toEqual({
    version: 1,
    engine: 'system',
    pack: 'calm',
    voiceURI: '',
    cloudVoice: 'diana',
    rate: 1.2,
    pitch: 0.86,
  });

  // 「念不念」的开关也搬到这张卡里了，落盘仍然在 senses-v1.json（它属于感官权限）。
  await card.getByLabel('让它念出来').check();
  // 文件是异步落盘的：第一次读可能还不存在，读不到就返回 null 让 poll 继续等。
  await expect
    .poll(async () => {
      try {
        return JSON.parse(await readFile(join(directory, 'senses-v1.json'), 'utf8')).voice;
      } catch {
        return null;
      }
    })
    .toBe(true);

  await app!.close();
  app = undefined;
  const restarted = await launch();
  await restarted.panel.getByRole('button', { name: '问问伙伴' }).click();
  const reopened = restarted.panel.getByTestId('ai-voice');
  await expect(reopened.locator('.label')).toHaveText('沉稳 · 1.20×');
  await expect(reopened.getByTestId('voice-engine-system')).toHaveAttribute('aria-checked', 'true');
  await expect(reopened.getByTestId('voice-pack-calm')).toHaveAttribute('aria-checked', 'true');
  await expect(reopened.getByLabel('让它念出来')).toBeChecked();
});

test('vision: 看画面默认关闭，允许后才真的去取一帧', async ({}, info) => {
  const { panel } = await launch();
  await panel.getByRole('button', { name: '问问伙伴' }).click();
  const card = panel.getByTestId('ai-vision');
  await expect(card).toBeVisible();
  // 截屏是侵入性能力：装好之后必须是「不许看」，不能默认打开。
  await expect(card.locator('.label')).toHaveText('不许看');
  await expect(card.getByTestId('vision-allow-screen')).not.toBeChecked();
  await expect(card.getByTestId('vision-allow-camera')).not.toBeChecked();
  await expect(card.getByTestId('vision-status')).toContainText('缺 Key');

  await card.getByTestId('vision-allow-screen').check();
  await card.getByRole('button', { name: '保存眼力' }).click();
  await expect(card).toContainText('已保存');
  // 文件是异步落盘的：读不到就返回 null 让 poll 继续等。
  await expect
    .poll(async () => {
      try {
        return JSON.parse(await readFile(join(directory, 'vision-v1.json'), 'utf8')).allowScreen;
      } catch {
        return null;
      }
    })
    .toBe(true);

  // 这个环境没有硅基流动的 Key：点「看一眼」要如实说缺 Key，
  // 不能截了图、发不出去，还回一句「看到了」。
  await card.getByRole('button', { name: '看一眼屏幕' }).click();
  await expect(card.locator('p.muted').last()).toContainText('Key');
  await card.screenshot({ path: info.outputPath('19-vision-card.png') });
});

test('delegate: 派活与命令默认关着，授权后写进磁盘并在下一句话生效', async ({}, info) => {
  const { panel } = await launch();
  await panel.getByRole('button', { name: '问问伙伴' }).click();
  const card = panel.getByTestId('ai-delegate');
  await expect(card).toBeVisible();
  // 这是本项目第一次把「动手权」交出去：装上之后必须是关的。
  await expect(card.locator('.label')).toHaveText('外包关 · 命令关');
  await expect(card.getByTestId('delegate-allow-agents')).not.toBeChecked();
  await expect(card.getByTestId('delegate-allow-shell')).not.toBeChecked();
  // 四个目标（WorkBuddy / Claude Code / Codex / 自定义）都要探测一遍，
  // 面板才知道能派给谁（这台机器装没装不影响断言条数）。
  await expect(card.getByTestId('delegate-targets').locator('li')).toHaveCount(4);
  // 等待上限必须能调，且默认不能是 2 分钟——改代码加跑测试根本不够用。
  await expect(card.getByTestId('delegate-timeout')).toHaveValue('10');
  // 30/60/90/120 分钟都要真的出现在下拉里（选项来自核心 delegateLimits.timeoutChoices）。
  for (const minutes of [30, 60, 90, 120]) {
    await expect(
      card.getByTestId('delegate-timeout').locator(`option[value="${minutes}"]`),
    ).toHaveCount(1);
  }

  await card.getByTestId('delegate-allow-agents').check();
  await card.getByTestId('delegate-timeout').selectOption('20');
  await card.getByRole('button', { name: '保存授权' }).click();
  await expect(card).toContainText('已保存');
  // 默认自动挑、用不了自动换：不用每次点名。
  await expect(card.locator('.label')).toContainText('自动挑');
  await expect(card.getByTestId('delegate-target')).toHaveValue('auto');
  await expect(card.getByTestId('delegate-fallback')).toBeChecked();

  await expect
    .poll(async () => {
      try {
        return JSON.parse(await readFile(join(directory, 'delegate-v1.json'), 'utf8')).allowAgents;
      } catch {
        return null;
      }
    })
    .toBe(true);

  // 命令开关没点，就必须仍然是关的：两个开关不能一起被带开。
  expect(JSON.parse(await readFile(join(directory, 'delegate-v1.json'), 'utf8')).allowShell).toBe(
    false,
  );
  // 超时档位也要真落盘，不能只是面板上看着变了。
  expect(
    JSON.parse(await readFile(join(directory, 'delegate-v1.json'), 'utf8')).timeoutMinutes,
  ).toBe(20);
  expect(JSON.parse(await readFile(join(directory, 'delegate-v1.json'), 'utf8'))).toMatchObject({
    target: 'auto',
    fallback: true,
  });
  await card.screenshot({ path: info.outputPath('20-delegate-card.png') });
});

test('mcp: 面板里加一台 stdio 服务器，连上、列出工具、设免确认，密钥不出主进程', async ({}, info) => {
  const { panel, pet } = await launch();
  await panel.getByRole('button', { name: '问问伙伴' }).click();
  const card = panel.getByTestId('ai-mcp');
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '加一台服务器' }).click();
  await card.getByLabel('MCP 服务器名').fill('fake');
  await card.getByLabel('启动命令').fill(process.execPath);
  await card.getByLabel('启动参数').fill(join(root, 'tests', 'fixtures', 'fake-mcp-server.mjs'));
  await card.getByLabel('环境变量').fill('FAKE_TOKEN=e2e-secret-value');
  await card.getByRole('button', { name: '保存并连接' }).click();
  const list = card.getByTestId('mcp-servers');
  await expect(list).toContainText('已连上 · 4 个工具', { timeout: 20_000 });
  await expect(list).toContainText('密钥：FAKE_TOKEN');

  await card.getByRole('button', { name: '工具', exact: true }).click();
  // 勾选是受控的：主进程存好、推回快照后才变，所以点一下再等。
  await card.getByLabel('echo 免确认').click();
  await expect(card.getByLabel('echo 免确认')).toBeChecked();
  await expect
    .poll(async () => {
      const state = await panel.evaluate(() => window.companion!.mcpState());
      return state.servers[0]?.tools.find((tool) => tool.name === 'echo')?.trust;
    })
    .toBe('auto');

  // 密钥只在主进程：面板拿到的快照、落盘的两个文件里都没有明文。
  const snapshot = await panel.evaluate(() => window.companion!.mcpState());
  expect(JSON.stringify(snapshot)).not.toContain('e2e-secret-value');
  for (const file of ['mcp-servers-v1.json', 'mcp-secrets-v1.json']) {
    expect(await readFile(join(directory, file), 'utf8')).not.toContain('e2e-secret-value');
  }
  // 桌宠窗口碰不到 MCP 配置。
  const fromPet = await pet.evaluate(() => window.companion!.mcpState()).catch(() => null);
  expect(fromPet).toBeNull();
  await card.screenshot({ path: info.outputPath('21-mcp-card.png') });

  await card.getByRole('button', { name: '删除' }).click();
  await expect(card.getByTestId('mcp-servers')).toHaveCount(0);
});

test('v0.2 companion: due todo nudges on the pet, A accepts, simulated device mirrors and presses', async ({}, info) => {
  const { panel, pet } = await launch({ proactive: true });
  await pet.getByRole('button', { name: '打开控制面板' }).click();
  await expect.poll(() => visible('panel')).toBe(true);

  // 刚过点的待办：到点检查每 15 秒一次，小屏应当主动亮一张卡。
  const past = new Date(Date.now() - 60_000);
  const pad = (value: number) => `${value}`.padStart(2, '0');
  const local = `${past.getFullYear()}-${pad(past.getMonth() + 1)}-${pad(past.getDate())}T${pad(past.getHours())}:${pad(past.getMinutes())}`;
  await panel.getByRole('textbox', { name: '新待办' }).fill('交周报');
  await panel.getByLabel('到点提醒（可选）').fill(local);
  await panel.getByRole('button', { name: '添加待办' }).click();
  await expect(panel.getByTestId('todo-due').first()).toContainText('已到点');

  const nudge = pet.getByTestId('pet-nudge');
  await expect(nudge).toContainText('交周报', { timeout: 25_000 });
  await pet.screenshot({ path: info.outputPath('21-pet-nudge.png') });
  // A 短按 = 接住这张卡（不是摸摸）；待办到点没有「细说」，不会发起 AI 对话。
  await pet.getByRole('button', { name: 'A 互动按钮' }).click();
  await expect(nudge).toHaveCount(0);
  await expect(pet.getByTestId('pet-ai-thread')).toHaveCount(0);

  await panel.getByRole('button', { name: '伙伴与设备' }).click();
  await expect(panel.getByTestId('nudge-history')).toContainText('交周报');
  await expect(panel.getByTestId('bond-card')).toBeVisible();

  // 模拟设备走完整协议：握手 → 镜像画面 → 按键回到同一张意图表。
  const device = panel.getByTestId('device-card');
  await device.getByRole('combobox', { name: '连接方式' }).selectOption('simulated');
  const enable = device.getByRole('checkbox', { name: '启用实体设备' });
  // 切换连接方式会先存盘，存的过程中开关是禁用的。
  await expect(enable).toBeEnabled();
  await enable.check();
  await expect(panel.getByTestId('device-status')).toHaveClass(/device-connected/, {
    timeout: 10_000,
  });
  await expect(panel.getByTestId('device-mirror')).toBeVisible();
  const simA = device.getByRole('button', { name: '模拟按 A' });
  await simA.dispatchEvent('pointerdown');
  await pet.waitForTimeout(120);
  await simA.dispatchEvent('pointerup');
  await expect(pet.getByTestId('screen-title')).toHaveText(petReaction);
  await expect(panel.getByTestId('device-mirror')).toContainText(petReaction);
  await device.screenshot({ path: info.outputPath('22-device-card.png') });

  // 设备配置已落盘，里面没有任何密钥类字段。
  const saved = await readFile(join(directory, 'device-v1.json'), 'utf8');
  expect(JSON.parse(saved)).toMatchObject({ enabled: true, mode: 'simulated' });
  expect(saved).not.toMatch(/key|token|secret/i);

  // 多 agent：Claude Code 默认不看；打开后，它卡在问你话上时小屏主动说一句。
  const session = join(directory, 'claude', 'demo');
  await mkdir(session, { recursive: true });
  await writeFile(
    join(session, 'cc1.jsonl'),
    `${JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      sessionId: 'cc1',
      cwd: join(directory, 'demo'),
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: {} }],
      },
    })}\n`,
    'utf8',
  );
  const sources = panel.getByTestId('agent-sources-card');
  await expect(sources.getByRole('checkbox', { name: '盯着 Claude Code' })).not.toBeChecked();
  await expect(pet.getByTestId('pet-nudge')).toHaveCount(0);
  await sources.getByRole('checkbox', { name: '盯着 Claude Code' }).check();
  await expect(pet.getByTestId('pet-nudge')).toContainText('Claude Code', { timeout: 10_000 });
  await expect(panel.getByTestId('agent-sources-live')).toContainText('Claude Code · demo');
  expect(
    JSON.parse(await readFile(join(directory, 'agent-sources-v1.json'), 'utf8')),
  ).toMatchObject({ claudeCode: true, codex: false });
  await pet.screenshot({ path: info.outputPath('23-pet-agent-waiting.png') });
  expect(errors).toEqual([]);
});

test('v0.3: official hooks report waiting, company card, and IoT through the simulated hub', async ({}, info) => {
  const { panel, pet } = await launch({ proactive: true });
  await pet.getByRole('button', { name: '打开控制面板' }).click();
  await panel.getByRole('button', { name: '伙伴与设备' }).click();

  // 官方钩子：装进（临时目录里的）settings.json，用户原有字段保留。
  await mkdir(join(directory, 'claude-home'), { recursive: true });
  await writeFile(
    join(directory, 'claude-home', 'settings.json'),
    JSON.stringify({ theme: 'dark' }),
    'utf8',
  );
  const hooks = panel.getByTestId('hooks-claude-code');
  await expect(hooks).toContainText('未安装');
  await hooks.getByRole('button', { name: '安装' }).click();
  await expect(hooks).toContainText('已安装');
  const settings = JSON.parse(
    await readFile(join(directory, 'claude-home', 'settings.json'), 'utf8'),
  ) as { theme: string; hooks: Record<string, unknown[]> };
  expect(settings.theme).toBe('dark');
  expect(JSON.stringify(settings.hooks['PermissionRequest'])).toContain('xinban-hook');

  // 远程批准默认开、等 45 秒（2026-11-12 用户定）。
  const remote = panel.getByTestId('remote-approve-card');
  await expect(remote.getByTestId('remote-approve-enabled')).toBeChecked();
  await expect(remote.getByTestId('remote-approve-wait')).toHaveValue('45000');

  // 用装好的真脚本模拟 Claude Code 触发「要你批准」：钩子会等芯伴上的回答，所以异步跑。
  const { spawn } = await import('node:child_process');
  const fire = (command: string) =>
    new Promise<{ status: number | null; stdout: string }>((done) => {
      const child = spawn(process.execPath, [
        join(directory, 'hooks', 'xinban-hook.cjs'),
        'claude',
        join(directory, 'agent-events', 'events.ndjson'),
      ]);
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.on('close', (status) => done({ status, stdout }));
      child.stdin.end(
        JSON.stringify({
          session_id: 'e2e-session',
          hook_event_name: 'PermissionRequest',
          cwd: join(directory, 'shop-api'),
          tool_name: 'Bash',
          tool_input: { command },
        }),
      );
    });
  const banner = panel.getByTestId('confirm-banner');
  const first = fire('npm test');
  await expect(banner).toContainText('Claude Code 想运行命令 · shop-api', { timeout: 10_000 });
  await expect(banner).toContainText('npm test');
  await expect(banner).toContainText('秒内不回答就交回终端');
  await expect(banner.getByTestId('confirm-remember')).toBeVisible();
  await pet.screenshot({ path: info.outputPath('30-pet-remote-approve.png') });
  await banner.screenshot({ path: info.outputPath('30-panel-remote-approve.png') });
  // 交回终端：钩子不输出，对方照常弹窗；仍算「在等你」。
  await banner.getByTestId('confirm-defer').click();
  const deferred = await first;
  expect(deferred).toEqual({ status: 0, stdout: '' });
  await expect(banner).toHaveCount(0);
  await expect(pet.getByTestId('pet-nudge')).toContainText('Claude Code', { timeout: 20_000 });
  await expect(panel.getByTestId('hooks-live')).toContainText('shop-api · 在等你确认');
  await pet.screenshot({ path: info.outputPath('31-pet-hook-waiting.png') });
  await panel.getByTestId('hooks-card').screenshot({ path: info.outputPath('32-hooks-card.png') });
  // 在芯伴上允许：钩子当场输出 allow。
  const second = fire('npm run lint');
  await expect(banner).toContainText('npm run lint', { timeout: 10_000 });
  await banner.getByRole('button', { name: '允许', exact: true }).click();
  const allowed = await second;
  expect(allowed.status).toBe(0);
  expect(JSON.parse(allowed.stdout)).toEqual({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
  // 运行状况卡：版本、日志目录在，启动后日志文件已经落盘。
  await expect(panel.getByTestId('health-card')).toContainText('打开日志目录');
  expect(
    (await readdir(join(directory, 'logs'))).some((name) => /^app-\d{8}\.log$/.test(name)),
  ).toBe(true);
  await hooks.getByRole('button', { name: '卸载' }).click();
  await expect(hooks).toContainText('未安装');
  expect(
    JSON.parse(await readFile(join(directory, 'claude-home', 'settings.json'), 'utf8')),
  ).toEqual({ theme: 'dark' });

  // 陪伴卡：测试里关了媒体桥，就照实说用不了；讲故事入口在。
  const company = panel.getByTestId('company-card');
  await expect(company.getByTestId('music-now')).toContainText('用不了系统媒体控制');
  await expect(company.getByTestId('panel-story')).toBeVisible();

  // 物联网：登记 → 模拟中枢报状态 → 面板开关 → 中枢回执。
  const iot = panel.getByTestId('iot-card');
  await expect(iot.getByTestId('iot-hub')).toContainText('中枢不在线');
  await iot.getByRole('textbox', { name: '设备名字' }).fill('台灯');
  await iot.getByRole('textbox', { name: '设备地址' }).fill('8.8.8.8');
  await iot.getByRole('button', { name: '登记' }).click();
  await expect(iot.getByRole('alert')).toContainText('局域网');
  await iot.getByRole('textbox', { name: '设备地址' }).fill('192.168.1.23');
  await iot.getByRole('button', { name: '登记' }).click();
  await expect(iot.getByTestId('iot-d1')).toContainText('台灯');
  await expect(iot.getByTestId('iot-state-d1')).toContainText('不确定');

  const device = panel.getByTestId('device-card');
  await device.getByRole('combobox', { name: '连接方式' }).selectOption('simulated');
  const enable = device.getByRole('checkbox', { name: '启用实体设备' });
  await expect(enable).toBeEnabled();
  await enable.check();
  await expect(iot.getByTestId('iot-hub')).toContainText('SIM-WIFI', { timeout: 10_000 });
  await expect(iot.getByTestId('iot-state-d1')).toContainText('关着');
  await iot.getByTestId('iot-d1').getByRole('button', { name: '打开' }).click();
  await expect(iot.getByTestId('iot-state-d1')).toContainText('开着 · 12.5W');
  await iot.screenshot({ path: info.outputPath('33-iot-card.png') });
  const registry = await readFile(join(directory, 'iot-v1.json'), 'utf8');
  expect(JSON.parse(registry)).toMatchObject({
    devices: [{ id: 'd1', name: '台灯', kind: 'tasmota', host: '192.168.1.23' }],
  });
  expect(registry).not.toMatch(/password|ssid|key|token/i);
  expect(errors).toEqual([]);
});

for (const conflict of [false, true]) {
  test(`file transaction UI: ${conflict ? 'refuses conflicting undo' : 'restores a durable backup and survives restart'}`, async () => {
    const project = resolve(await mkdtemp(join(tmpdir(), 'xinban-e2e-project-')));
    try {
      const target = join(project, 'note.txt');
      await writeFile(target, 'original');
      const files = new FileAccessService(
        {
          config: join(directory, 'file-roots-v1.json'),
          changes: join(directory, 'file-changes-v1.json'),
          backups: join(directory, 'file-backups'),
        },
        { home: join(directory, 'home'), userData: directory, appDir: root },
      );
      await files.load();
      expect(await files.add(project, true)).toEqual({ ok: true });
      await files.commit(
        {
          root: files.roots()[0]!.name,
          expected: captureFile(project, target),
          after: Buffer.from('assistant edit'),
          tool: 'write_file',
          revision: files.revision(),
        },
        new AbortController().signal,
      );
      if (conflict) await writeFile(target, 'new manual edit');
      let { panel } = await launch();
      await panel.getByRole('button', { name: '问问伙伴' }).click();
      let card = panel.getByTestId('ai-files');
      await expect(card.getByTestId('files-changes')).toContainText(target);
      await card.getByRole('button', { name: '撤销', exact: true }).click();
      if (conflict) await expect(card.getByRole('alert')).toContainText('存在冲突');
      else await expect(card.getByTestId('files-changes')).toContainText('已撤销');
      expect(await readFile(target, 'utf8')).toBe(conflict ? 'new manual edit' : 'original');
      await app!.close();
      app = undefined;
      ({ panel } = await launch());
      await panel.getByRole('button', { name: '问问伙伴' }).click();
      card = panel.getByTestId('ai-files');
      if (!conflict) await expect(card.getByTestId('files-changes')).toContainText('已撤销');
      expect(await readFile(target, 'utf8')).toBe(conflict ? 'new manual edit' : 'original');
    } finally {
      if (!project.startsWith(resolve(tmpdir()) + sep + 'xinban-e2e-project-'))
        throw new Error('Unsafe test cleanup');
      await rm(project, { recursive: true, force: true });
    }
  });
}

test('file transaction UI: damaged journal is visible and never silently overwritten', async () => {
  const journal = join(directory, 'file-changes-v1.json');
  await writeFile(journal, '{broken journal');
  const { panel } = await launch();
  await panel.getByRole('button', { name: '问问伙伴' }).click();
  await expect(panel.getByTestId('ai-files').getByRole('alert')).toContainText(
    '改动记录无法读取或已损坏',
  );
  await expect(panel.getByTestId('ai-files').getByRole('alert')).toHaveCSS(
    'color',
    'rgb(163, 70, 53)',
  );
  expect(await readFile(journal, 'utf8')).toBe('{broken journal');
});

test('file transaction UI: legacy history is visible without an unsafe undo button', async () => {
  await writeFile(
    join(directory, 'file-changes-v1.json'),
    JSON.stringify({
      version: 1,
      changes: [
        {
          id: 'legacy',
          at: 1,
          root: 'old',
          path: join(directory, 'legacy-note.txt'),
          action: 'created',
          tool: 'write_file',
          backup: null,
          undone: false,
        },
      ],
    }),
  );
  const { panel } = await launch();
  await panel.getByRole('button', { name: '问问伙伴' }).click();
  const changes = panel.getByTestId('files-changes');
  await expect(changes).toContainText('旧记录/冲突，需人工核对');
  await expect(changes.getByRole('button', { name: '撤销', exact: true })).toHaveCount(0);
});

test('speech audio: continuous scheduling of synthesized segments and stop', async () => {
  const { panel } = await launch();
  await app!.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.setAudioMuted(true);
  });
  // Inject the production audio module via the debugger evaluation context, not a production test hook.
  const bundle = await build({
    entryPoints: [join(root, 'src/renderer/pcmAudio.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: '__pcmHarness',
    platform: 'browser',
  });
  await panel.evaluate(bundle.outputFiles[0]!.text + '\n globalThis.__pcmHarness = __pcmHarness;');
  const result = await panel.evaluate(async () => {
    const pcm = Reflect.get(window, '__pcmHarness') as typeof import('../src/renderer/pcmAudio');
    // 0.1 s of 16 kHz mono PCM16 sine: stands in for one synthesized segment.
    const count = 1600;
    const wav = new ArrayBuffer(44 + count * 2);
    const view = new DataView(wav);
    const text = (at: number, value: string): void => {
      for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
    };
    text(0, 'RIFF');
    view.setUint32(4, wav.byteLength - 8, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, count * 2, true);
    for (let i = 0; i < count; i++)
      view.setInt16(44 + i * 2, Math.round(Math.sin(i / 10) * 3000), true);
    const player = new pcm.PcmSpeechAudio();
    const audio = await player.prepare(wav);
    const start = AudioBufferSourceNode.prototype.start;
    const starts: number[] = [];
    const ended: number[] = [];
    let failures = 0;
    AudioBufferSourceNode.prototype.start = function (...args) {
      starts.push(args[0] ?? 0);
      start.apply(this, args);
    };
    try {
      await new Promise<void>((resolve) => {
        player.enqueue(
          audio,
          () => ended.push(1),
          () => {
            failures++;
            resolve();
          },
        );
        player.enqueue(
          audio,
          () => {
            ended.push(2);
            resolve();
          },
          () => {
            failures++;
            resolve();
          },
        );
        setTimeout(resolve, 3000);
      });
      player.enqueue(
        audio,
        () => ended.push(3),
        () => {
          failures++;
        },
      );
      player.stop();
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      player.stop();
      AudioBufferSourceNode.prototype.start = start;
    }
    return { starts, ended, failures, duration: audio.duration };
  });
  expect(result).toMatchObject({ ended: [1, 2], failures: 0 });
  expect(result.starts[1]! - result.starts[0]!).toBeCloseTo(result.duration, 4);
});

for (const startupDelayMs of [0, 6500]) {
  test(`camera burst: ${startupDelayMs ? 'slow first frame' : 'normal startup'} preserves ordered frames and releases every track`, async ({}, info) => {
    const { panel, pet } = await launch();
    await panel.getByRole('button', { name: '问问伙伴' }).click();
    const card = panel.getByTestId('ai-vision');
    await card.getByTestId('vision-allow-camera').check();
    await card.getByRole('button', { name: '保存眼力' }).click();
    await expect(card).toContainText('已保存');
    await pet.evaluate((delayMs) => {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      const diagnostic: { event: string; at: number; visibility: string; ready?: number }[] = [];
      Reflect.set(window, '__cameraDiagnostic', diagnostic);
      const event = (name: string, ready?: number) =>
        diagnostic.push({
          event: name,
          at: performance.now(),
          visibility: document.visibilityState,
          ready,
        });
      const play = HTMLVideoElement.prototype.play;
      HTMLVideoElement.prototype.play = function () {
        event('play:start', this.readyState);
        for (const name of ['loadeddata', 'playing', 'pause', 'error'])
          this.addEventListener(name, () => event(name, this.readyState));
        const started = performance.now();
        return play.call(this).then(async () => {
          const remaining = delayMs - (performance.now() - started);
          if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
          event('play:resolved', this.readyState);
        });
      };
      const tracks: MediaStreamTrack[] = [];
      Reflect.set(window, '__cameraTracks', tracks);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        event('getUserMedia:start');
        const stream = await original(constraints);
        event('getUserMedia:resolved');
        tracks.push(...stream.getTracks());
        return stream;
      };
    }, startupDelayMs);
    // The model is disabled in E2E. Exercise only the real capture IPC with Chromium's fake device.
    const frames = await app!.evaluate(
      ({ BrowserWindow, ipcMain }) =>
        new Promise<{ bytes: number; capturedAt: number; width: number; height: number }[]>(
          (resolve, reject) => {
            const petWindow = BrowserWindow.getAllWindows().find((window) =>
              window.webContents.getURL().includes('window=companion'),
            )!;
            const id = 'fixed-camera-smoke';
            const finish = (
              _event: unknown,
              requestId: unknown,
              raw: { bytes: ArrayBuffer; capturedAt: number; width: number; height: number }[],
            ) => {
              if (requestId !== id) return;
              clearTimeout(timer);
              ipcMain.removeListener('companion:camera-frame', finish);
              resolve(
                raw.map((frame) => ({
                  bytes: frame.bytes.byteLength,
                  capturedAt: frame.capturedAt,
                  width: frame.width,
                  height: frame.height,
                })),
              );
            };
            const timer = setTimeout(() => {
              ipcMain.removeListener('companion:camera-frame', finish);
              reject(new Error('capture timeout'));
            }, 16000);
            ipcMain.on('companion:camera-frame', finish);
            petWindow.webContents.send('companion:capture-frame', id);
          },
        ),
    );
    const diagnostic = await pet.evaluate(() => ({
      events: Reflect.get(window, '__cameraDiagnostic') as unknown,
      videos: Array.from(document.querySelectorAll('video')).map((video) => ({
        ready: video.readyState,
        paused: video.paused,
        width: video.videoWidth,
      })),
    }));
    await info.attach('camera-lifecycle', {
      body: JSON.stringify(diagnostic),
      contentType: 'application/json',
    });
    expect(frames.length, JSON.stringify(diagnostic)).toBeGreaterThanOrEqual(3);
    expect(frames.length).toBeLessThanOrEqual(5);
    for (const frame of frames) {
      // 假摄像头在高负载下首帧可能近乎纯黑，JPEG 仅 ~750 字节；这里只验是非空的真图。
      expect(frame.bytes).toBeGreaterThan(500);
      expect(frame.width).toBeGreaterThan(0);
      expect(frame.height).toBeGreaterThan(0);
    }
    // 帧间距按连拍间隔来，留 10% 计时抖动余量。
    expect(frames.at(-1)!.capturedAt - frames[0]!.capturedAt).toBeGreaterThanOrEqual(
      (frames.length - 1) * visionLimits.frameIntervalMs * 0.9,
    );
    for (let i = 1; i < frames.length; i++)
      expect(frames[i]!.capturedAt).toBeGreaterThan(frames[i - 1]!.capturedAt);
    await expect
      .poll(() =>
        pet.evaluate(() => {
          const tracks = Reflect.get(window, '__cameraTracks') as MediaStreamTrack[];
          return tracks.length > 0 && tracks.every((track) => track.readyState === 'ended');
        }),
      )
      .toBe(true);
  });
}

test('camera cancellation: a late device grant is stopped and cannot wedge the next capture', async () => {
  const { panel, pet } = await launch();
  await panel.getByRole('button', { name: '问问伙伴' }).click();
  const card = panel.getByTestId('ai-vision');
  await card.getByTestId('vision-allow-camera').check();
  await card.getByRole('button', { name: '保存眼力' }).click();
  await expect(card).toContainText('已保存');
  await pet.evaluate(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    Reflect.set(window, '__originalGetUserMedia', original);
    const tracks: MediaStreamTrack[] = [];
    Reflect.set(window, '__lateTracks', tracks);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      await new Promise((resolve) => setTimeout(resolve, 9500));
      const stream = await original(constraints);
      tracks.push(...stream.getTracks());
      return stream;
    };
  });
  const capture = (id: string) =>
    app!.evaluate(
      ({ BrowserWindow, ipcMain }, requestId) =>
        new Promise<number>((resolve, reject) => {
          const window = BrowserWindow.getAllWindows().find((item) =>
            item.webContents.getURL().includes('window=companion'),
          )!;
          const finish = (_event: unknown, id: unknown, frames: unknown[]) => {
            if (id !== requestId) return;
            clearTimeout(timer);
            ipcMain.removeListener('companion:camera-frame', finish);
            resolve(frames.length);
          };
          const timer = setTimeout(() => {
            ipcMain.removeListener('companion:camera-frame', finish);
            reject(new Error('capture remained wedged'));
          }, 16000);
          ipcMain.on('companion:camera-frame', finish);
          window.webContents.send('companion:capture-frame', requestId);
        }),
      id,
    );
  expect(await capture('delayed-camera')).toBe(0);
  await expect
    .poll(() =>
      pet.evaluate(() => {
        const tracks = Reflect.get(window, '__lateTracks') as MediaStreamTrack[];
        return tracks.length > 0 && tracks.every((track) => track.readyState === 'ended');
      }),
    )
    .toBe(true);
  await pet.evaluate(() => {
    navigator.mediaDevices.getUserMedia = Reflect.get(
      window,
      '__originalGetUserMedia',
    ) as typeof navigator.mediaDevices.getUserMedia;
  });
  expect(await capture('recovered-camera')).toBeGreaterThanOrEqual(3);
});
