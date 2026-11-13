import { describe, expect, it } from 'vitest';
import {
  customBinProblem,
  customTarget,
  defaultDelegate,
  delegateCommand,
  delegateErrorText,
  delegateLabel,
  delegateLimits,
  delegateOutput,
  delegatePrompt,
  delegateTargets,
  delegateTimeoutMs,
  delegateUnauthenticated,
  delegateCrashed,
  normalizeDelegate,
  stripAnsi,
  targetOf,
  taskProblem,
  type DelegateConfig,
} from '../src/core/delegate';

const openConfig: DelegateConfig = { ...defaultDelegate, allowAgents: true, customArgs: [] };

describe('委派配置', () => {
  it('没存过时两项都是关的', () => {
    expect(normalizeDelegate(undefined)).toMatchObject({
      allowAgents: false,
      allowShell: false,
      target: defaultDelegate.target,
      customArgs: [],
    });
  });

  it('脏值不会变成「默认允许」', () => {
    const config = normalizeDelegate({
      allowAgents: 'yes',
      allowShell: 1,
      target: 'rm-rf',
      customBin: 42,
      customArgs: ['a', 7, 'b'],
    });
    expect(config.allowAgents).toBe(false);
    expect(config.allowShell).toBe(false);
    expect(config.target).toBe(defaultDelegate.target);
    expect(config.customBin).toBe('');
    expect(config.customArgs).toEqual(['a', 'b']);
  });

  it('自定义参数与命令长度有上限', () => {
    const config = normalizeDelegate({
      allowAgents: true,
      customArgs: Array.from({ length: 20 }, (_, index) => `a${index}`),
      customBin: 'x'.repeat(500),
    });
    expect(config.customArgs.length).toBe(10);
    expect(config.customBin.length).toBeLessThanOrEqual(260);
  });

  it('配置归一化原样保留 30/60/90/120 分钟', () => {
    for (const minutes of [30, 60, 90, 120]) {
      expect(normalizeDelegate({ timeoutMinutes: minutes }).timeoutMinutes).toBe(minutes);
    }
  });
});

describe('命令行拼装', () => {
  it('预设目标把任务放进 stdin，命令行里只有固定参数', () => {
    const command = delegateCommand(delegateTargets[0]!, '修一下登录按钮的样式');
    expect(command.stdin).toBe(true);
    expect(command.args.join(' ')).not.toContain('登录按钮');
    expect(command.args).toContain('-p');
  });

  it('自定义命令没写 {task} 也走 stdin', () => {
    const target = customTarget({ ...openConfig, target: 'custom', customBin: 'C:/tools/a.cmd' });
    expect(delegateCommand(target, '干活').stdin).toBe(true);
  });

  it('自定义命令写了 {task} 才拼进参数', () => {
    const target = customTarget({
      ...openConfig,
      target: 'custom',
      customBin: 'C:/tools/a.cmd',
      customArgs: ['run', '--prompt', '{task}'],
    });
    const command = delegateCommand(target, '整理文档');
    expect(command.stdin).toBe(false);
    expect(command.args).toEqual(['run', '--prompt', '整理文档']);
  });

  it('目标 id 不认识时回到默认预设', () => {
    expect(targetOf(openConfig, 'nope' as never).id).toBe(delegateTargets[0]!.id);
  });
});

describe('输入校验', () => {
  it('自定义命令里不能夹带管道、重定向或 &&', () => {
    expect(customBinProblem('')).not.toBe('');
    for (const bad of ['claude && rm -rf /', 'x | y', 'a > b', 'a %PATH%', 'a\nb']) {
      expect(customBinProblem(bad)).not.toBe('');
    }
    expect(customBinProblem('C:/tools/agent.cmd')).toBe('');
  });

  it('任务不能空、不能超长', () => {
    expect(taskProblem('')).not.toBe('');
    expect(taskProblem(' '.repeat(30))).not.toBe('');
    expect(taskProblem('x'.repeat(801))).not.toBe('');
    expect(taskProblem('把登录页的报错修掉')).toBe('');
  });
});

describe('输出整理', () => {
  it('去掉颜色与进度条回车', () => {
    const text = stripAnsi('\u001b[32m完成\u001b[0m\n下载 10%\r下载 100%\n');
    expect(text).not.toContain('\u001b[');
    expect(text).toContain('完成');
    expect(text).toContain('下载 100%');
    expect(text).not.toContain('下载 10%');
  });

  it('长输出保留结尾，并说明前面省略了多少', () => {
    const text = delegateOutput(`${'过程日志。'.repeat(1_500)}\n结论：测试通过`);
    expect(text).toContain('结论：测试通过');
    expect(text).toContain('已省略');
    expect(text.length).toBeLessThan(6_200);
  });

  it('退出码 0 但没登录的「假成功」要认出来', () => {
    // WorkBuddy 的 CLI 没登录时就是这样：退出码 0，只在 stderr 打一行。
    const raw = 'Authentication required. Please use /login command to sign in to your account';
    expect(delegateUnauthenticated(raw)).toBe(true);
    expect(delegateUnauthenticated('改完了，测试通过。')).toBe(false);
    expect(delegateUnauthenticated('')).toBe(false);
    // 正常结论里提到这几个词不算：它得是短提示才可疑（长文里的引用不拦）。
    expect(
      delegateUnauthenticated(
        `我修好了。${'过程日志。'.repeat(200)}原来报的是 Authentication required`,
      ),
    ).toBe(false);
  });

  it('超时档位：默认 10 分钟，坏值夹到合法档位，绝不允许无限等待', () => {
    expect(delegateTimeoutMs(10)).toBe(600_000);
    expect(delegateTimeoutMs(20)).toBe(1_200_000);
    expect(delegateTimeoutMs(30)).toBe(1_800_000);
    expect(delegateTimeoutMs(60)).toBe(3_600_000);
    expect(delegateTimeoutMs(90)).toBe(5_400_000);
    expect(delegateTimeoutMs(120)).toBe(7_200_000);
    // 面板传来的非法值、手改配置文件的极端值：都不能变成「不限时」。
    expect(delegateTimeoutMs(undefined)).toBe(600_000);
    expect(delegateTimeoutMs('abc')).toBe(600_000);
    expect(delegateTimeoutMs(-100)).toBe(120_000);
    expect(delegateTimeoutMs(99999)).toBe(7_200_000);
    expect(delegateTimeoutMs(Number.NaN)).toBe(600_000);
  });

  it('面板档位包含 30/60/90/120 分钟，且每档都没被上限夹回 30', () => {
    const choices = delegateLimits.timeoutChoices as readonly number[];
    for (const minutes of [30, 60, 90, 120]) {
      expect(choices).toContain(minutes);
      expect(delegateTimeoutMs(minutes)).toBe(minutes * 60_000);
    }
    // 兜底上限至少等于最大档位，不能还停在 30 分钟。
    expect(delegateLimits.maxTimeoutMs).toBeGreaterThanOrEqual(120 * 60_000);
  });

  it('空输出也有话说', () => {
    expect(delegateOutput('   ')).toContain('没有输出');
  });

  it('找不到命令 / 没登录 / 没权限各有各的说法', () => {
    const target = delegateTargets[0]!;
    expect(delegateErrorText(target, 9009, '')).toContain('找不到');
    expect(delegateErrorText(target, 1, 'Error: not logged in')).toContain('登录');
    expect(delegateErrorText(target, 1, 'permission denied by policy')).toContain('权限');
  });

  // 实测这台机器 cc-switch 接第三方模型时 Claude Code 每次都会往 stderr 打的两行。
  const ccSwitchNoise = [
    "⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai login · Unset it to load your organization's connectors",
    'Claude Code doesn\'t recognize the model "gpt-6.1-sol", so it assumes a context window of 200k tokens.',
    '[claude-code:unrecognized_model] {"model":"gpt-6.1-sol","query_source":"sdk"}',
  ].join('\n');

  it('cc-switch 的启动提示不算「没登录」，也不进「对方说」', () => {
    const target = delegateTargets[0]!;
    const text = delegateErrorText(target, 1, `${ccSwitchNoise}\nError: tool crashed`);
    expect(text).not.toContain('认证');
    expect(text).not.toContain('登录');
    expect(text).toContain('退出码 1');
    expect(text).toContain('tool crashed');
    expect(text).not.toContain('connectors');
    expect(delegateUnauthenticated(ccSwitchNoise)).toBe(false);
  });

  it('请求 ID 里碰巧带 401、提到 api key 都不再误判成没登录', () => {
    const target = delegateTargets[0]!;
    expect(delegateErrorText(target, 1, 'request id 20261109-4013-abc failed')).not.toContain(
      '认证',
    );
    expect(delegateErrorText(target, 1, 'set your api key in config.toml')).not.toContain('认证');
  });

  it('真正的认证失败还认，并提醒可能是 cc-switch 那边的 key', () => {
    const target = delegateTargets[0]!;
    for (const raw of [
      'Invalid API key · Please run /login',
      'API Error: 401 {"error":"unauthorized"}',
      'Error: not logged in',
    ]) {
      const text = delegateErrorText(target, 1, `${ccSwitchNoise}\n${raw}`);
      expect(text).toContain('认证没通过');
      expect(text).toContain('cc-switch');
    }
  });

  it('入口缺模块崩溃但退出码 0：认成失败而不是结论', () => {
    // 实测：WorkBuddy 自带 CLI 不设 CODEBUDDY_FORCE_LITE_WB_BUNDLE 时就是这样。
    const crash = [
      "Error: Cannot find module '../dist/codebuddy'",
      'Require stack:',
      '- E:\\workbuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy',
      '    at Module._resolveFilename (node:internal/modules/cjs/loader:1456:15) {',
      "  code: 'MODULE_NOT_FOUND',",
      '}',
    ].join('\n');
    expect(delegateCrashed(crash)).toBe(true);
    expect(delegateCrashed('改好了。之前报 Cannot find module 是因为路径写错。')).toBe(false);
    expect(delegateCrashed('')).toBe(false);
  });

  it('网关限流 / 上游连不上单独说，不推给登录', () => {
    const target = delegateTargets[0]!;
    for (const raw of [
      'API Error: 502 转发失败: 上游连接失败',
      'API Error: 429 rate limit exceeded',
      'API Error: Connection error.',
    ]) {
      const text = delegateErrorText(target, 1, raw);
      expect(text).toContain('模型服务出错');
      expect(text).toContain('不是你没登录');
    }
  });
});

describe('提示词与标签', () => {
  it('两项都关时不占提示词', () => {
    expect(delegatePrompt(defaultDelegate, [])).toBe('');
  });

  it('开了外包但没装命令，提示词会要求如实说明', () => {
    const text = delegatePrompt(openConfig, [
      { id: 'claude', label: 'Claude Code', available: false, path: '' },
    ]);
    expect(text).toContain('没探测到');
    expect(text).toContain('delegate_task');
  });

  it('开了命令时把边界一起写进去', () => {
    const text = delegatePrompt({ ...openConfig, target: 'claude', allowShell: true }, [
      { id: 'claude', label: 'Claude Code', available: true, path: 'C:/npm/claude.cmd' },
    ]);
    expect(text).toContain('shell_command');
    expect(text).toContain('不要用它删文件');
    expect(text).toContain('Claude Code');
  });

  it('面板标签能看出开没开', () => {
    expect(delegateLabel(defaultDelegate)).toContain('外包关');
    expect(delegateLabel({ ...openConfig, target: 'claude', allowShell: true })).toContain(
      'Claude Code',
    );
    expect(delegateLabel({ ...openConfig, allowShell: true })).toContain('命令开');
  });
});
