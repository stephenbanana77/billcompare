import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, Search } from 'lucide-react';
import { reconciliationApi } from '@/api';
import IssueResolutionDialog from '@/components/IssueResolutionDialog';
import StatusBadge from '@/components/StatusBadge';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Money,
  PageIntro,
} from '@/components/ViewHelpers';
import type { ReconciliationIssue } from '@/types/reconciliation';

function displayDueDate(issue: ReconciliationIssue) {
  if (issue.dueDate) return issue.dueDate;
  const date = new Date(issue.createdAt);
  date.setDate(date.getDate() + (issue.severity === 'high' ? 2 : 3));
  return date.toISOString().slice(0, 10);
}

export default function IssuesPage() {
  const [status, setStatus] = useState('active');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ReconciliationIssue | null>(null);
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['issues'],
    queryFn: reconciliationApi.issues,
  });
  const rows = query.data ?? [];
  const filtered = useMemo(
    () =>
      rows.filter(({ issue, job }) => {
        const activeMatch =
          status === 'all' ||
          (status === 'active'
            ? issue.status !== 'resolved'
            : issue.status === status);
        const searchMatch =
          `${issue.title} ${job.taskNo} ${job.mallName} ${job.storeName}`
            .toLowerCase()
            .includes(search.toLowerCase());
        return activeMatch && searchMatch;
      }),
    [rows, search, status],
  );

  if (query.isLoading) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error?.message} />;

  return (
    <div className="page-stack">
      <PageIntro
        title="异常处理队列"
        description="自动生成处理截止日；异常需经处理、提交复核、批准关闭或打回，所有流转均留痕。"
      />
      <div className="toolbar-row">
        <label className="search-box">
          <Search size={16} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索异常、任务或商场"
          />
        </label>
        <select
          className="filter-select"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="active">待处理与处理中</option>
          <option value="open">仅待处理</option>
          <option value="in_progress">仅处理中</option>
          <option value="pending_approval">待复核</option>
          <option value="rejected">已打回</option>
          <option value="resolved">已解决</option>
          <option value="all">全部状态</option>
        </select>
      </div>
      <section className="section-block">
        {rows.length === 0 ? (
          <EmptyState
            title="当前没有异常"
            description="导入并计算后，超过容忍值的字段差异会自动进入这里。"
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="没有匹配的异常"
            description="调整筛选条件后再试。"
          />
        ) : (
          <div className="issue-list">
            {filtered.map(({ issue, job }) => (
              <article className="issue-row" key={issue.id}>
                <span
                  className={`severity-marker severity-${issue.severity}`}
                />
                <div className="issue-main">
                  <div className="issue-title-row">
                    <strong>{issue.title}</strong>
                    <StatusBadge status={issue.status} />
                  </div>
                  <p>{issue.description}</p>
                  <div className="issue-meta">
                    <button onClick={() => navigate(`/jobs/${job.id}`)}>
                      {job.taskNo}
                    </button>
                    <span>
                      {job.mallName} · {job.storeName}
                    </span>
                    <span>
                      {job.periodStart} 至 {job.periodEnd}
                    </span>
                    <span>处理人：{issue.assignedTo || '未分派'}</span>
                    <span
                      className={
                        displayDueDate(issue) < new Date().toISOString().slice(0, 10) &&
                        issue.status !== 'resolved'
                          ? 'overdue-text'
                          : ''
                      }
                    >
                      截止：{displayDueDate(issue)}
                    </span>
                  </div>
                </div>
                <div className="issue-amount">
                  <small>差异金额</small>
                  <strong
                    className={
                      Number(issue.differenceAmount) === 0 ? '' : 'danger-text'
                    }
                  >
                    <Money value={issue.differenceAmount} signed />
                  </strong>
                </div>
                <button
                  className="button secondary compact"
                  onClick={() => setSelected(issue)}
                >
                  <CheckCircle2 size={15} />
                  处理
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
      <IssueResolutionDialog
        issue={selected}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}
