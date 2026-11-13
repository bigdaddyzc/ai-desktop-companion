import { describe, expect, it } from 'vitest';
import type { AiStatus } from '../src/core/ai';
import { emptyDelegateSnapshot } from '../src/core/delegate';
import type { HooksStatus, HookTargetStatus } from '../src/core/hook-install';
import { setupSteps } from '../src/core/setup-check';

const target = (status: HookTargetStatus['status']): HookTargetStatus => ({
  status,
  path: '',
  note: '',
});

function hooks(node: boolean, claude: HookTargetStatus['status']): HooksStatus {
  return {
    claudeCode: target(claude),
    codex: target('absent'),
    workbuddy: target('absent'),
    codebuddy: target('absent'),
    node,
    lastEventAt: 0,
  };
}

const ai = (configured: boolean) => ({ configured }) as AiStatus;

describe('setupSteps', () => {
  it('什么都读不到时四步都没做', () => {
    expect(setupSteps({ hooks: null, delegate: null, ai: null }).every((step) => !step.done)).toBe(
      true,
    );
  });

  it('逐项判断', () => {
    const delegate = emptyDelegateSnapshot();
    const ready = {
      ...delegate,
      config: { ...delegate.config, projectsRoot: 'D:\\work' },
      projectsError: '',
    };
    const steps = setupSteps({ hooks: hooks(true, 'installed'), delegate: ready, ai: ai(true) });
    expect(steps.map((step) => step.done)).toEqual([true, true, true, true]);
    expect(steps[1]!.label).toContain('1 个');

    const broken = setupSteps({
      hooks: hooks(false, 'partial'),
      delegate: { ...ready, projectsError: '读不了' },
      ai: ai(false),
    });
    expect(broken.map((step) => step.done)).toEqual([false, false, false, false]);
    expect(broken.every((step) => step.hint !== '')).toBe(true);
  });
});
