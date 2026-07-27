import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { FilePlus2, Search } from 'lucide-react';
import { reconciliationApi } from '@/api';
import type { LayoutContext } from '@/components/Layout';
import StatusBadge from '@/components/StatusBadge';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Money,
  PageIntro,
  formatDate,
} from '@/components/ViewHelpers';

export default function JobsPage() {
  const { openImport } = useOutletContext<LayoutContext>();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const query = useQuery({
    queryKey: ['jobs'],
    queryFn: reconciliationApi.jobs,
  });
  const jobs = query.data ?? [];
  const filtered = useMemo(
    () =>
      jobs.filter((job) => {
        const text =
          `${job.taskNo} ${job.mallName} ${job.storeName} ${job.storeCode}`.toLowerCase();
        return (
          text.includes(search.toLowerCase()) &&
          (status === 'all' || job.status === status)
        );
      }),
    [jobs, search, status],
  );

  if (query.isLoading) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error?.message} />;

  return (
    <div className="page-stack">
      <PageIntro
        title="全部对账任务"
        description="每次导入形成一笔独立任务，保留规则快照、分项差异和处理记录。"
        actions={
          <button className="button primary" onClick={openImport}>
            <FilePlus2 size={17} />
            新建任务
          </button>
        }
      />
      <div className="toolbar-row">
        <label className="search-box">
          <Search size={16} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索任务、商场或门店"
          />
        </label>
        <select
          className="filter-select"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="all">全部状态</option>
          <option value="matched">自动通过</option>
          <option value="needs_review">待处理</option>
          <option value="resolved">已解决</option>
        </select>
      </div>
      <section className="section-block">
        {jobs.length === 0 ? (
          <EmptyState
            title="暂无对账任务"
            description="当前数据库为空。导入真实或外部样例文件后，任务才会出现在这里。"
            action={
              <button className="button primary" onClick={openImport}>
                <FilePlus2 size={17} />
                导入文件
              </button>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="没有匹配结果"
            description="调整搜索关键词或状态筛选后再试。"
          />
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>任务编号</th>
                  <th>商场 / 门店</th>
                  <th>账期</th>
                  <th>账单类型</th>
                  <th>销售差异</th>
                  <th>结算差异</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((job) => (
                  <tr key={job.id} onClick={() => navigate(`/jobs/${job.id}`)}>
                    <td>
                      <strong>{job.taskNo}</strong>
                      <small>{formatDate(job.createdAt)}</small>
                    </td>
                    <td>
                      {job.mallName}
                      <small>
                        {job.storeName} · {job.storeCode}
                      </small>
                    </td>
                    <td>
                      {job.periodStart}
                      <small>至 {job.periodEnd}</small>
                    </td>
                    <td>{billTypeLabel(job.billType)}</td>
                    <td
                      className={
                        Number(job.salesDiff) === 0 ? '' : 'danger-text'
                      }
                    >
                      <Money value={job.salesDiff} signed />
                    </td>
                    <td
                      className={
                        Number(job.settlementDiff) === 0 ? '' : 'danger-text'
                      }
                    >
                      <Money value={job.settlementDiff} signed />
                    </td>
                    <td>
                      <StatusBadge status={job.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function billTypeLabel(value: string) {
  return (
    (
      {
        standard: '标准扣点',
        complex: '扣点与费用',
        changed_format: '格式变化',
      } as Record<string, string>
    )[value] ?? value
  );
}
