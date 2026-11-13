import { useEffect, useState } from 'react';
import { defaultPersona, type PersonaConfig } from '../core/persona';

/**
 * 只读的性格配置。
 *
 * 面板里那份是「编辑态」，保存前不落盘；桌宠需要的是「已保存的那份」，
 * 两者混用会出现「面板改了字但没保存，屏幕已经变了」的错觉。
 * 读失败就安静地用默认值——屏幕少一句自定义文案，总比整块屏报错好。
 */
export function usePersona(): PersonaConfig {
  const [config, setConfig] = useState<PersonaConfig>(() => ({ ...defaultPersona }));

  useEffect(() => {
    const bridge = window.companion;
    if (!bridge) return;
    let alive = true;
    const off = bridge.onPersonaState((next) => {
      if (alive) setConfig(next);
    });
    void bridge
      .personaState()
      .then((next) => {
        if (alive) setConfig(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off();
    };
  }, []);

  return config;
}
