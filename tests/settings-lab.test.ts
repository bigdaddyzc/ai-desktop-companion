import { describe, expect, it } from 'vitest';
import { actionSchema, settingsSchema } from '../src/core/schema';

describe('模拟实验室开关', () => {
  it('旧存档没有 showLab 照样能读，默认藏着', () => {
    const old = settingsSchema.parse({ alwaysOnTop: false, quiet: false, reducedMotion: false });
    expect(old.showLab).toBeUndefined();
    expect(
      settingsSchema.parse({
        alwaysOnTop: false,
        quiet: false,
        reducedMotion: false,
        showLab: true,
      }).showLab,
    ).toBe(true);
  });

  it('面板能单独打开它，但不接受乱传的值', () => {
    expect(
      actionSchema.safeParse({ type: 'settings.patch', patch: { showLab: true } }).success,
    ).toBe(true);
    expect(
      actionSchema.safeParse({ type: 'settings.patch', patch: { showLab: 'yes' } }).success,
    ).toBe(false);
  });
});
