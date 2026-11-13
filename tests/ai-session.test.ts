import { describe, expect, it } from 'vitest';
import {
  appendDelta,
  beginRequest,
  emptyAiSession,
  fail,
  historyFor,
  lastExchange,
  maxAiTurns,
  settle,
  trimTurns,
} from '../src/core/ai-session';

const turn = (role: 'user' | 'assistant', content: string) => ({ role, content });

describe('AI 会话状态', () => {
  it('初始为空且不在忙碌', () => {
    const state = emptyAiSession();
    expect(state.turns).toEqual([]);
    expect(state.streaming).toBe('');
    expect(state.busy).toBe(false);
    expect(state.error).toBe('');
  });

  it('发起请求时立刻把用户这句话上屏并进入忙碌', () => {
    const state = beginRequest(emptyAiSession(), '今天适合跑步吗');
    expect(state.turns).toEqual([{ role: 'user', content: '今天适合跑步吗' }]);
    expect(state.busy).toBe(true);
    expect(state.streaming).toBe('');
    expect(state.revision).toBe(1);
  });

  it('重复提问同一句话不会被去重掉，两轮都保留', () => {
    let state = beginRequest(emptyAiSession(), '你好');
    state = settle(state, '你好呀');
    state = beginRequest(state, '你好');
    expect(state.turns).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好呀' },
      { role: 'user', content: '你好' },
    ]);
  });

  it('增量按到达顺序累积', () => {
    let state = beginRequest(emptyAiSession(), '数到三');
    state = appendDelta(state, '一');
    state = appendDelta(state, '二');
    state = appendDelta(state, '三');
    expect(state.streaming).toBe('一二三');
  });

  it('非忙碌状态下迟到的增量被忽略，不会污染下一轮', () => {
    const settled = settle(beginRequest(emptyAiSession(), '问'), '答');
    const late = appendDelta(settled, '迟到文字');
    // 引用不变：调用方据此判断「没有变化」，不触发跨窗口广播。
    expect(late).toBe(settled);
    expect(late.streaming).toBe('');
  });

  it('成功收尾把完整回复落成一轮并清空流式缓冲', () => {
    const state = settle(beginRequest(emptyAiSession(), '问'), '答');
    expect(state.turns).toEqual([
      { role: 'user', content: '问' },
      { role: 'assistant', content: '答' },
    ]);
    expect(state.streaming).toBe('');
    expect(state.busy).toBe(false);
    expect(state.error).toBe('');
  });

  it('失败时保留提问、丢弃半截回复，并记录原因', () => {
    let state = beginRequest(emptyAiSession(), '问');
    state = appendDelta(state, '说到一半');
    state = fail(state, '回复超时中断，半截内容已丢弃。');
    expect(state.turns).toEqual([{ role: 'user', content: '问' }]);
    expect(state.streaming).toBe('');
    expect(state.busy).toBe(false);
    expect(state.error).toBe('回复超时中断，半截内容已丢弃。');
  });

  it('新一轮请求会清掉上一轮的错误', () => {
    let state = fail(beginRequest(emptyAiSession(), '问'), '网络不通');
    state = beginRequest(state, '再试一次');
    expect(state.error).toBe('');
    expect(state.busy).toBe(true);
  });

  it('按上限裁剪历史，只留最近的轮次', () => {
    const turns = Array.from({ length: maxAiTurns + 10 }, (_, index) =>
      turn(index % 2 === 0 ? 'user' : 'assistant', `第${index}条`),
    );
    const trimmed = trimTurns(turns);
    expect(trimmed).toHaveLength(maxAiTurns);
    expect(trimmed[trimmed.length - 1]).toEqual(turns[turns.length - 1]);
  });

  it('lastExchange 取最后一句问答，进行中的流式文字优先', () => {
    let state = beginRequest(emptyAiSession(), '第一问');
    state = settle(state, '第一答');
    state = beginRequest(state, '第二问');
    state = appendDelta(state, '正在说');
    expect(lastExchange(state)).toEqual({ question: '第二问', answer: '正在说' });
  });

  it('还没有回复时 lastExchange 为 null，桌宠不该假装说过话', () => {
    expect(lastExchange(emptyAiSession())).toBeNull();
    expect(lastExchange(beginRequest(emptyAiSession(), '只问了还没答'))).toBeNull();
  });

  it('failure 后 lastExchange 回到上一条已完成的回答', () => {
    let state = beginRequest(emptyAiSession(), '第一问');
    state = settle(state, '第一答');
    state = beginRequest(state, '第二问');
    state = fail(state, '超时');
    expect(lastExchange(state)).toEqual({ question: '第一问', answer: '第一答' });
  });
});

describe('构造请求历史', () => {
  it('不把本次提问重复塞进历史', () => {
    const turns = [turn('user', '上一问'), turn('assistant', '上一答')];
    const history = historyFor(turns, '这次的问题');
    expect(history).toEqual([
      { role: 'user', content: '上一问' },
      { role: 'assistant', content: '上一答' },
    ]);
  });

  it('turns 末尾已是当前提问时把它排除，避免同一句发两次', () => {
    const turns = [turn('user', '上一问'), turn('assistant', '上一答'), turn('user', '这次')];
    const history = historyFor(turns, '这次');
    expect(history.some((item) => item.content === '这次')).toBe(false);
  });

  it('只保留最近若干条，且单条内容被截断到 IPC 上限', () => {
    const long = 'x'.repeat(10_000);
    const turns = Array.from({ length: 30 }, (_, index) =>
      turn(index % 2 === 0 ? 'user' : 'assistant', `${long}${index}`),
    );
    const history = historyFor(turns, '新问题');
    expect(history.length).toBeLessThanOrEqual(12);
    for (const item of history) expect(item.content.length).toBeLessThanOrEqual(4_000);
  });
});
