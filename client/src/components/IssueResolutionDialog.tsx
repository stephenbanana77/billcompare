import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock3, X } from 'lucide-react';
import { toast } from 'sonner';
import type { IssueStatus } from '@shared/reconciliation';
import { reconciliationApi } from '@/api';
import type { ReconciliationIssue } from '@/types/reconciliation';

const statusLabel: Record<IssueStatus, string> = {
  open: '待处理',
  in_progress: '处理中',
  pending_approval: '待复核',
  resolved: '已关闭',
  rejected: '已打回',
};

function displayDueDate(issue: ReconciliationIssue) {
  if (issue.dueDate) return issue.dueDate;
  const date = new Date(issue.createdAt);
  date.setDate(date.getDate() + (issue.severity === 'high' ? 2 : 3));
  return date.toISOString().slice(0, 10);
}

export default function IssueResolutionDialog({
  issue,
  onClose,
}: {
  issue: ReconciliationIssue | null;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<IssueStatus>('in_progress');
  const [note, setNote] = useState('');
  const [evidence, setEvidence] = useState('');
  const [assignee, setAssignee] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [reviewerName, setReviewerName] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const queryClient = useQueryClient();
  const eventsQuery = useQuery({
    queryKey: ['issue-events', issue?.id],
    queryFn: () => reconciliationApi.issueEvents(issue!.id),
    enabled: Boolean(issue),
  });
  const selectableStatuses = useMemo<IssueStatus[]>(() => {
    if (!issue) return ['in_progress'];
    if (issue.status === 'pending_approval') return ['resolved', 'rejected'];
    if (issue.status === 'resolved') return ['resolved', 'in_progress'];
    return ['open', 'in_progress', 'pending_approval'];
  }, [issue]);

  useEffect(() => {
    const nextStatus =
      issue?.status === 'pending_approval'
        ? 'resolved'
        : issue?.status === 'resolved'
          ? 'resolved'
          : 'in_progress';
    setStatus(nextStatus);
    setNote(issue?.resolutionNote ?? '');
    setEvidence(issue?.resolutionEvidence ?? '');
    setAssignee(issue?.assignedTo ?? '');
    setDueDate(issue ? displayDueDate(issue) : '');
    setReviewerName(issue?.reviewerName ?? '');
    setReviewNote(issue?.reviewNote ?? '');
  }, [issue]);

  const needsReview = status === 'resolved' || status === 'rejected';
  const mutation = useMutation({
    mutationFn: () =>
      reconciliationApi.updateIssue(issue!.id, {
        status,
        resolutionNote: note,
        resolutionEvidence: evidence,
        assignedTo: assignee,
        dueDate,
        reviewerName,
        reviewNote,
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['issues'] }),
        queryClient.invalidateQueries({ queryKey: ['jobs'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['job', issue?.jobId] }),
        queryClient.invalidateQueries({ queryKey: ['issue-events', issue?.id] }),
      ]);
      toast.success(status === 'pending_approval' ? '已提交复核' : '异常工单已更新');
      onClose();
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : '更新失败'),
  });
  if (!issue) return null;

  return (
    <div className="dialog-backdrop">
      <section className="small-dialog workflow-dialog" role="dialog" aria-modal="true">
        <header className="dialog-header">
          <div>
            <p className="eyebrow">异常工单</p>
            <h2>{issue.title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="dialog-body form-stack">
          <div className="issue-context">
            <strong>系统建议</strong>
            <p>{issue.suggestedAction}</p>
          </div>
          <div className="workflow-meta">
            <span>当前状态：{statusLabel[issue.status]}</span>
            <span className={displayDueDate(issue) < new Date().toISOString().slice(0, 10) && issue.status !== 'resolved' ? 'overdue-text' : ''}>
              <Clock3 size={13} /> 截止：{displayDueDate(issue)}
            </span>
          </div>
          <div className="form-grid two">
            <label>
              流转动作
              <select value={status} onChange={(e) => setStatus(e.target.value as IssueStatus)}>
                {selectableStatuses.map((item) => (
                  <option value={item} key={item}>{statusLabel[item]}</option>
                ))}
              </select>
            </label>
            <label>
              处理人
              <input value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="填写姓名或岗位" />
            </label>
            <label>
              处理截止日
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </label>
          </div>
          <label>
            处理结论
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="记录核查结果、调整依据或申诉单号" />
          </label>
          <label>
            证据或附件说明
            <textarea rows={2} value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="例如：合同第 4.2 条、商场邮件、调整单号、附件位置" />
          </label>
          {needsReview && (
            <div className="review-panel">
              <strong>{status === 'resolved' ? '复核通过并关闭' : '复核打回'}</strong>
              <div className="form-grid two">
                <label>
                  复核人
                  <input value={reviewerName} onChange={(e) => setReviewerName(e.target.value)} placeholder="例如：财务主管" />
                </label>
                <label>
                  复核意见
                  <input value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} placeholder={status === 'rejected' ? '必须说明打回原因' : '可补充复核说明'} />
                </label>
              </div>
            </div>
          )}
          <div className="workflow-timeline">
            <strong>流转记录</strong>
            {eventsQuery.data?.length ? eventsQuery.data.map((event) => (
              <div key={event.id}>
                <span />
                <p><b>{event.operatorName}</b> {event.fromStatus ? `${statusLabel[event.fromStatus]} → ` : ''}{statusLabel[event.toStatus]}</p>
                <small>{event.comment || event.action} · {new Date(event.createdAt).toLocaleString('zh-CN')}</small>
              </div>
            )) : <p className="muted-copy">尚无人工流转记录，当前异常由系统自动识别。</p>}
          </div>
        </div>
        <footer className="dialog-footer">
          <button className="button secondary" onClick={onClose}>取消</button>
          <button
            className="button primary"
            disabled={
              mutation.isPending ||
              (status === 'pending_approval' && !note.trim()) ||
              (needsReview && !reviewerName.trim()) ||
              (status === 'rejected' && !reviewNote.trim())
            }
            onClick={() => mutation.mutate()}
          >
            <CheckCircle2 size={16} />
            {mutation.isPending ? '保存中...' : status === 'pending_approval' ? '提交复核' : '保存流转结果'}
          </button>
        </footer>
      </section>
    </div>
  );
}
