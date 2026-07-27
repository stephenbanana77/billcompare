import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle2,
  FileSpreadsheet,
  History,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { reconciliationApi } from '@/api';
import ConfirmDialog from '@/components/ConfirmDialog';
import IssueResolutionDialog from '@/components/IssueResolutionDialog';
import StatusBadge from '@/components/StatusBadge';
import {
  ErrorState,
  LoadingState,
  Money,
  formatDate,
} from '@/components/ViewHelpers';
import type { ReconciliationIssue } from '@/types/reconciliation';

export default function JobDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedIssue, setSelectedIssue] =
    useState<ReconciliationIssue | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const query = useQuery({
    queryKey: ['job', id],
    queryFn: () => reconciliationApi.job(id),
    enabled: Boolean(id),
  });
  const deleteMutation = useMutation({
    mutationFn: () => reconciliationApi.deleteJob(id),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['job', id] });
      toast.success('任务已删除');
      navigate('/jobs', { replace: true });
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['jobs'] }),
        queryClient.invalidateQueries({ queryKey: ['issues'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : '删除失败'),
  });
  if (query.isLoading) return <LoadingState />;
  if (query.isError || !query.data)
    return <ErrorState message={query.error?.message} />;
  const { job, comparisons, issues, auditLogs } = query.data;
  const openIssues = issues.filter((issue) => issue.status !== 'resolved');

  return (
    <div className="page-stack">
      <div className="detail-toolbar">
        <button className="text-button" onClick={() => navigate('/jobs')}>
          <ArrowLeft size={16} />
          返回任务列表
        </button>
        <button
          className="button danger-outline"
          disabled={deleteMutation.isPending}
          onClick={() => setDeleteOpen(true)}
        >
          <Trash2 size={16} />
          删除任务
        </button>
      </div>
      <section className="detail-header">
        <div>
          <div className="detail-title-line">
            <h2>
              {job.mallName} · {job.storeName}
            </h2>
            <StatusBadge status={job.status} />
          </div>
          <p>
            {job.taskNo} · {job.periodStart} 至 {job.periodEnd} ·{' '}
            {job.storeCode}
          </p>
        </div>
        <div className="detail-total">
          <span>结算差异</span>
          <strong
            className={
              Number(job.settlementDiff) === 0 ? 'success-text' : 'danger-text'
            }
          >
            <Money value={job.settlementDiff} signed />
          </strong>
          <small>{openIssues.length} 项待处理</small>
        </div>
      </section>
      <section className="source-strip">
        <div>
          <FileSpreadsheet size={18} />
          <span>
            商场账单<strong>{job.sourceBillName}</strong>
          </span>
        </div>
        <div>
          <FileSpreadsheet size={18} />
          <span>
            ERP 数据
            {job.erpSnapshot.includedRowCount != null && (
              <>
                {' '}
                · 账期内 {job.erpSnapshot.includedRowCount}/
                {job.erpSnapshot.rowCount} 行
              </>
            )}
            <strong>{job.sourceErpName}</strong>
          </span>
        </div>
        <div>
          <span>
            规则快照
            <strong>
              {job.ruleSnapshot.name} · {job.ruleSnapshot.commissionRate}%
            </strong>
          </span>
        </div>
      </section>
      <section className="section-block">
        <div className="section-heading">
          <div>
            <h3>分项比对</h3>
            <p>商场账单值与 ERP / 规则计算值逐项核对</p>
          </div>
        </div>
        <div className="data-table-wrap">
          <table className="data-table comparison-table">
            <thead>
              <tr>
                <th>比对字段</th>
                <th>商场账单</th>
                <th>系统计算</th>
                <th>差异</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              {comparisons.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.fieldLabel}</strong>
                  </td>
                  <td>
                    <Money value={item.billValue} />
                  </td>
                  <td>
                    <Money value={item.erpValue} />
                  </td>
                  <td
                    className={
                      Number(item.difference) === 0 ? '' : 'danger-text'
                    }
                  >
                    <Money value={item.difference} signed />
                  </td>
                  <td>
                    <span className={`comparison-result ${item.result}`}>
                      {item.result === 'matched' ? '一致' : '有差异'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <div className="detail-grid">
        <section className="section-block">
          <div className="section-heading">
            <div>
              <h3>异常处理</h3>
              <p>
                {issues.length} 项异常，{openIssues.length} 项未完成
              </p>
            </div>
          </div>
          {issues.length === 0 ? (
            <div className="success-panel">
              <CheckCircle2 size={21} />
              <div>
                <strong>本任务自动通过</strong>
                <p>所有分项差异均在容忍范围内。</p>
              </div>
            </div>
          ) : (
            <div className="detail-issue-list">
              {issues.map((issue) => (
                <article key={issue.id}>
                  <span
                    className={`severity-marker severity-${issue.severity}`}
                  />
                  <div>
                    <div>
                      <strong>{issue.title}</strong>
                      <StatusBadge status={issue.status} />
                    </div>
                    <p>{issue.description}</p>
                    {issue.resolutionNote && (
                      <small>处理记录：{issue.resolutionNote}</small>
                    )}
                  </div>
                  <button
                    className="button secondary compact"
                    onClick={() => setSelectedIssue(issue)}
                  >
                    处理
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
        <section className="section-block">
          <div className="section-heading">
            <div>
              <h3>操作记录</h3>
              <p>任务的关键状态变化</p>
            </div>
            <History size={18} />
          </div>
          <div className="audit-list">
            {auditLogs.map((log) => (
              <div key={log.id}>
                <span />
                <div>
                  <strong>{auditLabel(log.action)}</strong>
                  <p>
                    {log.operatorName} · {formatDate(log.createdAt)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      <IssueResolutionDialog
        issue={selectedIssue}
        onClose={() => setSelectedIssue(null)}
      />
      <ConfirmDialog
        open={deleteOpen}
        title={`删除任务 ${job.taskNo}`}
        description="该任务的分项比对、异常和操作记录将一并删除，此操作不能撤回。"
        confirmLabel="确认删除任务"
        busy={deleteMutation.isPending}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => deleteMutation.mutate()}
      />
    </div>
  );
}

function auditLabel(action: string) {
  return (
    (
      {
        job_created: '创建并完成自动对账',
        issue_status_changed: '更新异常处理状态',
      } as Record<string, string>
    )[action] ?? action
  );
}
