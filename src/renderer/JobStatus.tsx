import { useEffect, useState } from 'react';
import type { AiJob } from '../core/ai-session';

/** 干了多久：不到一分钟按秒，之后按「分 秒」。 */
export function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/**
 * 后台派活的状态条：派给谁、干什么、干了多久、对方最新一行输出，可以随时停下。
 * 对话不再为它卡在「回复中」，进度就靠这一条。
 */
export function JobStatus({ job, compact = false }: { job: AiJob; compact?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const task = job.task.length > 40 ? `${job.task.slice(0, 40)}…` : job.task;
  return (
    <div
      className={compact ? 'job-status compact' : 'job-status'}
      role="status"
      data-testid="job-status"
      data-pet-interactive
    >
      <div className="job-head">
        <span>
          🛠 {job.target} 在干{compact ? '' : `：${task}`}
        </span>
        <small className="muted">{elapsedText(now - job.startedAt)}</small>
        <button type="button" onClick={() => void window.companion?.delegateCancel()}>
          停下
        </button>
      </div>
      <small className="muted job-line" title={job.line}>
        {job.line === '' ? '还没有输出，在干…' : job.line}
      </small>
    </div>
  );
}
