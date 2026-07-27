import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FileText, PencilLine } from 'lucide-react';
import { toast } from 'sonner';
import { reconciliationApi } from '@/api';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Money,
  PageIntro,
  formatDate,
} from '@/components/ViewHelpers';
import type { VoucherRow } from '@/types/reconciliation';

export default function VouchersPage() {
  const [selected, setSelected] = useState<VoucherRow | null>(null);
  const query = useQuery({
    queryKey: ['vouchers'],
    queryFn: reconciliationApi.vouchers,
  });
  const rows = query.data ?? [];
  const draftCount = rows.filter((row) => row.voucher.status === 'draft').length;
  const confirmedCount = rows.filter(
    (row) => row.voucher.status === 'confirmed',
  ).length;

  if (query.isLoading) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error?.message} />;

  return (
    <div className="page-stack">
      <PageIntro
        title="记账准备"
        description="回款核销通过且对账异常已完结后，系统生成可确认的记账草稿。"
      />
      <section className="metric-grid">
        <article className="metric-card">
          <span className="metric-icon neutral">
            <FileText size={19} />
          </span>
          <div>
            <p>凭证草稿</p>
            <strong>{draftCount}</strong>
            <small>等待财务确认科目</small>
          </div>
        </article>
        <article className="metric-card">
          <span className="metric-icon success">
            <CheckCircle2 size={19} />
          </span>
          <div>
            <p>已确认</p>
            <strong>{confirmedCount}</strong>
            <small>可进入正式记账流程</small>
          </div>
        </article>
      </section>
      <section className="section-block">
        <div className="section-heading">
          <div>
            <h3>记账草稿</h3>
            <p>当前草稿为演示口径，正式科目仍需财务确认</p>
          </div>
          <span className="section-count">{rows.length} 条</span>
        </div>
        {rows.length === 0 ? (
          <EmptyState
            title="暂无记账草稿"
            description="先完成对账并导入匹配的回款流水，系统会自动生成草稿。"
          />
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>凭证号</th>
                  <th>商场 / 门店</th>
                  <th>凭证日期</th>
                  <th>摘要</th>
                  <th>金额</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.voucher.id}>
                    <td>
                      <strong>{row.voucher.voucherNo}</strong>
                      <small>{formatDate(row.voucher.createdAt)}</small>
                    </td>
                    <td>
                      {row.job.mallName}
                      <small>
                        {row.job.storeName} / {row.job.storeCode}
                      </small>
                    </td>
                    <td>{row.voucher.voucherDate}</td>
                    <td>{row.voucher.summary}</td>
                    <td>
                      <Money value={row.voucher.totalAmount} />
                    </td>
                    <td>
                      <span className={`status-badge status-${row.voucher.status}`}>
                        {row.voucher.status === 'confirmed' ? '已确认' : '草稿'}
                      </span>
                    </td>
                    <td>
                      <button
                        className="button secondary compact"
                        onClick={() => setSelected(row)}
                      >
                        <PencilLine size={15} />
                        查看
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <VoucherDialog row={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function VoucherDialog({
  row,
  onClose,
}: {
  row: VoucherRow | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [summary, setSummary] = useState(row?.voucher.summary ?? '');
  const [debitAccount, setDebitAccount] = useState(
    row?.voucher.debitAccount ?? '银行存款',
  );
  const [creditAccount, setCreditAccount] = useState(
    row?.voucher.creditAccount ?? '应收账款-商场',
  );
  useEffect(() => {
    setSummary(row?.voucher.summary ?? '');
    setDebitAccount(row?.voucher.debitAccount ?? '银行存款');
    setCreditAccount(row?.voucher.creditAccount ?? '应收账款-商场');
  }, [row]);
  const mutation = useMutation({
    mutationFn: (status?: 'draft' | 'confirmed') =>
      reconciliationApi.updateVoucher(row?.voucher.id ?? '', {
        summary,
        debitAccount,
        creditAccount,
        status,
      }),
    onSuccess: () => {
      toast.success('记账草稿已更新');
      onClose();
      void queryClient.invalidateQueries({ queryKey: ['vouchers'] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : '保存失败'),
  });

  if (!row) return null;

  return (
    <div className="dialog-backdrop">
      <section className="small-dialog">
        <div className="dialog-header">
          <div>
            <p className="topbar-kicker">记账草稿</p>
            <h2>{row.voucher.voucherNo}</h2>
          </div>
          <button className="icon-button" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="dialog-body form-stack">
          <div className="collection-summary">
            <span>
              金额 <strong><Money value={row.voucher.totalAmount} /></strong>
            </span>
            <span>
              借方 <strong>{debitAccount}</strong>
            </span>
            <span>
              贷方 <strong>{creditAccount}</strong>
            </span>
          </div>
          <label>
            摘要
            <input value={summary} onChange={(event) => setSummary(event.target.value)} />
          </label>
          <div className="form-grid two">
            <label>
              借方科目
              <input
                value={debitAccount}
                onChange={(event) => setDebitAccount(event.target.value)}
              />
            </label>
            <label>
              贷方科目
              <input
                value={creditAccount}
                onChange={(event) => setCreditAccount(event.target.value)}
              />
            </label>
          </div>
          <div className="data-table-wrap">
            <table className="data-table voucher-lines-table">
              <thead>
                <tr>
                  <th>方向</th>
                  <th>科目</th>
                  <th>金额</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>借</td>
                  <td>{debitAccount}</td>
                  <td>
                    <Money value={row.voucher.totalAmount} />
                  </td>
                </tr>
                <tr>
                  <td>贷</td>
                  <td>{creditAccount}</td>
                  <td>
                    <Money value={row.voucher.totalAmount} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div className="dialog-footer">
          <button className="button secondary" onClick={onClose}>
            取消
          </button>
          <div className="page-actions">
            <button
              className="button secondary"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate('draft')}
            >
              保存草稿
            </button>
            <button
              className="button primary"
              disabled={
                mutation.isPending || row.voucher.status === 'confirmed'
              }
              onClick={() => mutation.mutate('confirmed')}
            >
              确认凭证
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
