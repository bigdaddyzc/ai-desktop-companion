import { describe, expect, it } from 'vitest';
import {
  buildReplayScript,
  parseReplayScript,
  replayCapacity,
  replayScriptText,
} from '../src/core/replay';
import { initialState, reduce } from '../src/core/state';
import type { SimulationEvent } from '../src/core/schema';

function event(index: number, overrides: Partial<SimulationEvent> = {}): SimulationEvent {
  return {
    schemaVersion: 1,
    simulation: true,
    eventId: `e${index}`,
    sourceId: 'local-simulator',
    taskId: `task-${index}`,
    sequence: index + 1,
    title: `任务 ${index}`,
    status: 'running',
    ...overrides,
  };
}

describe('F-12 回放脚本', () => {
  it('没有事件时不生成脚本', () => {
    expect(buildReplayScript([])).toBeNull();
    expect(replayScriptText([])).toBeNull();
  });

  it('脚本保留最近 30 条事件，可序列化', () => {
    const events = Array.from({ length: 45 }, (_, index) => event(index));
    const script = buildReplayScript(events);
    expect(script?.events).toHaveLength(replayCapacity);
    expect(script?.events[0]?.eventId).toBe('e15');
    expect(script?.events.at(-1)?.eventId).toBe('e44');
    const parsed = parseReplayScript(replayScriptText(events)!);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.events).toHaveLength(replayCapacity);
  });

  it('拒绝非法 JSON、错误 kind／version、空序列、超长与字段不合法', () => {
    expect(parseReplayScript('{broken').ok).toBe(false);
    expect(
      parseReplayScript(JSON.stringify({ kind: 'other', version: 1, events: [event(0)] })).ok,
    ).toBe(false);
    expect(
      parseReplayScript(
        JSON.stringify({ kind: 'xinban-replay-script', version: 2, events: [event(0)] }),
      ).ok,
    ).toBe(false);
    expect(
      parseReplayScript(JSON.stringify({ kind: 'xinban-replay-script', version: 1, events: [] }))
        .ok,
    ).toBe(false);
    expect(
      parseReplayScript(
        JSON.stringify({
          kind: 'xinban-replay-script',
          version: 1,
          events: Array.from({ length: 31 }, (_, i) => event(i)),
        }),
      ).ok,
    ).toBe(false);
    expect(
      parseReplayScript(
        JSON.stringify({ kind: 'xinban-replay-script', version: 1, events: [{ eventId: 'x' }] }),
      ).ok,
    ).toBe(false);
  });
});

describe('F-12 完整 30 序列一致性集', () => {
  /** 混合重复 ID、乱序、终态后变更、不同任务与断线恢复。 */
  function mixedSequence(): SimulationEvent[] {
    const events: SimulationEvent[] = [];
    for (let index = 0; index < 30; index += 1) {
      events.push(event(index, { taskId: `task-${index % 6}`, sequence: index + 1 }));
    }
    events[5] = event(5, { eventId: 'e4', taskId: 'task-5', sequence: 6 }); // 重复 ID
    events[9] = event(9, { taskId: 'task-3', sequence: 0 }); // 乱序／过期
    events[12] = event(12, { taskId: 'task-0', status: 'succeeded', sequence: 13 }); // 终态
    events[18] = event(18, { taskId: 'task-0', status: 'running', sequence: 19 }); // 终态后变更
    return events;
  }

  it('批量 sim.script 与逐条 sim.event 得到完全相同的模拟状态', () => {
    const events = mixedSequence();
    const start = initialState(1_000);
    const batch = reduce(start, { type: 'sim.script', events }, { now: 1_000, id: 'ctx' });
    let sequential = start;
    for (const item of events) {
      sequential = reduce(
        sequential,
        { type: 'sim.event', event: item },
        { now: 1_000, id: 'ctx' },
      );
    }
    expect(batch.simulation).toEqual(sequential.simulation);
    expect(batch.simulation.events).toHaveLength(replayCapacity);
  });

  it('序列里确实包含被忽略的事件，且 journal 记录了忽略原因', () => {
    const events = mixedSequence();
    const state = reduce(
      initialState(1_000),
      { type: 'sim.script', events },
      { now: 1_000, id: 'ctx' },
    );
    expect(state.simulation.events).toHaveLength(30);
    expect(state.simulation.journal.some((line) => line.includes('已忽略重复事件'))).toBe(true);
    expect(state.simulation.journal.some((line) => line.includes('乱序'))).toBe(true);
    expect(state.simulation.journal.some((line) => line.includes('终态'))).toBe(true);
  });

  it('断线期间到达的事件仍进入回放脚本，但不会变成已确认的任务状态', () => {
    const start = initialState(1_000);
    const offline = reduce(
      start,
      { type: 'sim.connect', connected: false },
      { now: 1_000, id: 'x' },
    );
    const next = reduce(offline, { type: 'sim.event', event: event(0) }, { now: 1_000, id: 'x' });
    expect(next.simulation.events).toHaveLength(1);
    expect(next.simulation.tasks).toHaveLength(0);
    const reconnected = reduce(
      next,
      { type: 'sim.connect', connected: true },
      { now: 1_000, id: 'x' },
    );
    expect(reconnected.simulation.tasks).toHaveLength(0);
    expect(reconnected.simulation.events).toHaveLength(1);
  });
});

describe('F-03 A 键确认', () => {
  it('等待确认的任务被确认后继续运行，且不占用事件序号', () => {
    const now = 1_000;
    let state = reduce(initialState(now), { type: 'sim.event', event: event(0) }, { now, id: 'x' });
    state = reduce(
      state,
      {
        type: 'sim.event',
        event: event(1, { eventId: 'e1', taskId: 'task-0', sequence: 2, status: 'waiting' }),
      },
      { now, id: 'x' },
    );
    const before = state.simulation.tasks[0]!;
    expect(before.status).toBe('waiting');
    state = reduce(state, { type: 'sim.acknowledge', taskId: 'task-0' }, { now, id: 'x' });
    const after = state.simulation.tasks[0]!;
    expect(after.status).toBe('running');
    expect(after.sequence).toBe(before.sequence);
    expect(state.simulation.journal[0]).toContain('已确认继续');
  });

  it('没有等待中的任务时确认被忽略，不改变状态', () => {
    const now = 1_000;
    const state = reduce(
      initialState(now),
      { type: 'sim.acknowledge', taskId: 'missing' },
      { now, id: 'x' },
    );
    expect(state.simulation.tasks).toHaveLength(0);
    expect(state.simulation.journal[0]).toContain('确认已忽略');
  });
});
