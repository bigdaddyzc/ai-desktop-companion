import type { AiStatus } from './ai';
import type { DelegateSnapshot } from './delegate';
import type { HooksStatus } from './hook-install';

/**
 * 首启检查（M6）：用已有的状态拼一张清单，告诉新用户还差哪几步。
 * 不自己去探测任何东西，也不替你装；每一步指到已有的卡片。纯领域层。
 */

export interface SetupStep {
  key: 'node' | 'hooks' | 'projects' | 'model';
  label: string;
  done: boolean;
  /** 没做完时该去哪里弄。 */
  hint: string;
}

export function setupSteps(input: {
  hooks: HooksStatus | null;
  delegate: DelegateSnapshot | null;
  ai: AiStatus | null;
}): SetupStep[] {
  const { hooks, delegate, ai } = input;
  const targets = hooks ? [hooks.claudeCode, hooks.codex, hooks.workbuddy, hooks.codebuddy] : [];
  const installed = targets.filter((target) => target.status === 'installed').length;
  const root = delegate?.config.projectsRoot.trim() ?? '';
  return [
    {
      key: 'node',
      label: '找到 node',
      done: hooks?.node ?? false,
      hint: '钩子用 node 跑。装一个 Node.js（nodejs.org，LTS 即可），装完重开芯伴。',
    },
    {
      key: 'hooks',
      label: installed > 0 ? `装好钩子（${installed} 个 Agent）` : '装好钩子',
      done: installed > 0,
      hint: '在下面「官方通知钩子」卡里给 Claude Code / Codex / WorkBuddy 一键装钩子。',
    },
    {
      key: 'projects',
      label: '选好「我的项目」目录',
      done: root !== '' && (delegate?.projectsError ?? '') === '',
      hint: '在「问问伙伴 → 替它派活」里填项目根目录，芯伴才知道「在 xinban 项目里」指哪里。',
    },
    {
      key: 'model',
      label: '填好模型 Key',
      done: ai?.configured ?? false,
      hint: '在「问问伙伴 → 连接配置」里填模型地址和 Key，对话和派活都靠它。',
    },
  ];
}
