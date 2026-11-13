import { useEffect, useState } from 'react';
import type { UsageWeekView } from '../core/usage-stats';

function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function seconds(ms: number | null): string {
  return ms === null ? '—' : `${Math.round(ms / 1_000)} 秒`;
}

function minutes(ms: number): string {
  if (ms < 60_000) return ms === 0 ? '0' : '<1 分';
  const total = Math.round(ms / 60_000);
  return total < 60 ? `${total} 分` : `${Math.floor(total / 60)} 时 ${total % 60} 分`;
}

/**
 * 自用两周的四个计数：芯伴接住/交回、批准响应中位数、Agent 等待总时长、派活次数/成功率。
 * 只记次数和时长。打开时读一次，不实时刷新。
 */
export function UsageStats() {
  const [weeks, setWeeks] = useState<UsageWeekView[] | null>(null);
  useEffect(() => {
    let alive = true;
    void window
      .companion!.usageState()
      .then((next) => {
        if (alive) setWeeks(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  if (!weeks || weeks.length === 0) return null;
  return (
    <table className="usage-table" data-testid="usage-stats">
      <thead>
        <tr>
          <th />
          <th>本周</th>
          <th>上周</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th>芯伴接住 / 交回终端</th>
          {weeks.map((week) => (
            <td key={week.week}>
              {week.caught} / {week.handedBack}（{percent(week.caughtRate)}）
            </td>
          ))}
        </tr>
        <tr>
          <th>批准响应中位数</th>
          {weeks.map((week) => (
            <td key={week.week}>{seconds(week.medianResponseMs)}</td>
          ))}
        </tr>
        <tr>
          <th>Agent 等你总时长</th>
          {weeks.map((week) => (
            <td key={week.week}>{minutes(week.waitingMs)}</td>
          ))}
        </tr>
        <tr>
          <th>派活次数 / 成功率</th>
          {weeks.map((week) => (
            <td key={week.week}>
              {week.delegates}（{percent(week.delegateOkRate)}）
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}
