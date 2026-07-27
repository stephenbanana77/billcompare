import { useQuery } from '@tanstack/react-query';
import { useNavigate, useOutletContext } from 'react-router-dom';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  FilePlus2,
  ReceiptText,
  Scale,
} from 'lucide-react';
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

export default function DashboardPage() {
  const { openImport } = useOutletContext<LayoutContext>();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['dashboard'],
    queryFn: reconciliationApi.dashboard,
  });

  if (query.isLoading) return <LoadingState />;
  if (query.isError || !query.data)
    return <ErrorState message={query.error?.message} />;
  const data = query.data;

  return (
    <div className="page-stack">
      <PageIntro
        title="本期对账进度"
        description="汇总已导入的商场结算任务与待处理差异。"
      />
      <section className="metric-grid">
        <article className="metric-card">
          <span className="metric-icon neutral">
            <ReceiptText size={19} />
          </span>
          <div>
            <p>对账任务</p>
            <strong>{data.totalJobs}</strong>
            <small>累计导入</small>
          </div>
        </article>
        <article className="metric-card">
          <span className="metric-icon success">
            <CheckCircle2 size={19} />
          </span>
          <div>
            <p>自动通过率</p>
            <strong>{data.matchRate}%</strong>
            <small>{data.matchedJobs} 笔自动通过</small>
          </div>
        </article>
        <article className="metric-card">
          <span className="metric-icon warning">
            <AlertCircle size={19} />
          </span>
          <div>
            <p>待处理异常</p>
            <strong>{data.openIssues}</strong>
            <small>{data.reviewJobs} 个任务受影响</small>
          </div>
        </article>
        <article className="metric-card">
          <span className="metric-icon danger">
            <Scale size={19} />
          </span>
          <div>
            <p>待确认差异</p>
            <strong className="metric-money">
              <Money value={data.differenceAmount} />
            </strong>
            <small>按未解决异常统计</small>
          </div>
        </article>
      </section>

      <section className="section-block">
        <div className="section-heading">
          <div>
            <h3>最近任务</h3>
            <p>按导入时间倒序</p>
          </div>
          {data.totalJobs > 0 && (
            <button className="text-button" onClick={() => navigate('/jobs')}>
              查看全部
              <ArrowRight size={15} />
            </button>
          )}
        </div>
        {data.recentJobs.length === 0 ? (
          <EmptyState
            title="还没有对账任务"
            description="导入一份商场结算单和对应 ERP 数据后，系统将在这里生成第一笔任务。"
            action={
              <button className="button primary" onClick={openImport}>
                <FilePlus2 size={17} />
                导入第一笔
              </button>
            }
          />
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>任务编号</th>
                  <th>商场 / 门店</th>
                  <th>账期</th>
                  <th>结算差异</th>
                  <th>异常</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {data.recentJobs.map((job) => (
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
                    <td
                      className={
                        Number(job.settlementDiff) === 0 ? '' : 'danger-text'
                      }
                    >
                      <Money value={job.settlementDiff} signed />
                    </td>
                    <td>{job.issueCount}</td>
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
