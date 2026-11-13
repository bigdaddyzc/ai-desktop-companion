import { useEffect, useState } from 'react';
import { defaultVoice, type VoiceConfig } from '../core/voice';

/**
 * 语音包配置：面板负责写，桌宠只读。
 *
 * 和感官开关一样订阅同一份——面板里换完嗓子，桌宠下一句就用新的，
 * 不需要重启，也不需要两边各存一份（存两份迟早会不一致）。
 */
export function useVoiceConfig(): VoiceConfig {
  const [config, setConfig] = useState<VoiceConfig>(() => defaultVoice());
  useEffect(() => {
    let live = true;
    void window.companion!.voiceState().then((value) => {
      if (live) setConfig(value);
    });
    const off = window.companion!.onVoiceState(setConfig);
    return () => {
      live = false;
      off();
    };
  }, []);
  return config;
}
