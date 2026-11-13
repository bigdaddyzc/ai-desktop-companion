import { useState } from 'react';
import {
  faceCatalog,
  faceKeys,
  faceStyles,
  faceWhen,
  type FaceKey,
  type FacePrefs,
} from '../core/expression';
import { Face } from './Face';
import { usePersona } from './usePersona';

/**
 * 「表情」卡：换画风、关掉不想看到的表情、要不要跟着聊天情绪走。
 * 每次改动立刻保存，桌宠马上变；只存表情这一项，不碰性格里的其他设置。
 */
export function FaceCard() {
  const persona = usePersona();
  const prefs = persona.face;
  const [notice, setNotice] = useState('');

  async function save(next: FacePrefs) {
    setNotice('');
    try {
      const result = await window.companion!.personaSave({ face: next });
      setNotice(result.ok ? '' : (result.error ?? '没保存上，请重试。'));
    } catch {
      setNotice('没保存上，请重试。');
    }
  }

  function toggle(key: FaceKey) {
    const off = prefs.off.includes(key)
      ? prefs.off.filter((item) => item !== key)
      : [...prefs.off, key];
    void save({ ...prefs, off });
  }

  return (
    <section className="card" data-testid="face-card">
      <div className="section-heading">
        <h2>表情</h2>
        <span className="muted">按状态自动切换 · 共 {faceKeys.length} 种</span>
      </div>
      <div className="face-options">
        <label>
          画风
          <select
            aria-label="表情画风"
            value={prefs.style}
            onChange={(event) =>
              void save({ ...prefs, style: event.target.value as FacePrefs['style'] })
            }
          >
            {faceStyles.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={prefs.followChat}
            onChange={() => void save({ ...prefs, followChat: !prefs.followChat })}
          />
          跟着聊天情绪变（你不开心时担心、聊得开心时笑、它问你时歪头）
        </label>
      </div>
      <p className="muted">取消勾选的表情不再出现，该切到它时停在「安静」。</p>
      <ul className="face-grid" data-testid="face-grid">
        {faceKeys.map((key) => {
          const spec = faceCatalog[key];
          const enabled = !prefs.off.includes(key);
          return (
            <li key={key} className={enabled ? '' : 'face-off'}>
              <div className="face-preview">
                <Face spec={spec} open={0} talking={false} variant={prefs.style} />
              </div>
              <label>
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={key === 'idle'}
                  aria-label={`启用表情 ${spec.label}`}
                  onChange={() => toggle(key)}
                />
                {spec.label}
              </label>
              <small className="muted">{faceWhen[key]}</small>
            </li>
          );
        })}
      </ul>
      {notice !== '' && <p className="sense-error">{notice}</p>}
    </section>
  );
}
