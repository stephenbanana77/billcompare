import type { IssueStatus, JobStatus } from '@shared/reconciliation';

const labels: Record<JobStatus | IssueStatus, string> = {
  matched: '自动通过',
  needs_review: '待处理',
  resolved: '已解决',
  open: '待处理',
  in_progress: '处理中',
  pending_approval: '待复核',
  rejected: '已打回',
};

export default function StatusBadge({
  status,
}: {
  status: JobStatus | IssueStatus;
}) {
  return (
    <span className={`status-badge status-${status}`}>{labels[status]}</span>
  );
}
