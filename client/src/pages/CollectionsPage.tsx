import { ChangeEvent, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FileUp, Landmark, Search } from 'lucide-react';
import { toast } from 'sonner';
import type { ImportReceiptsInput } from '@shared/reconciliation';
import { reconciliationApi } from '@/api';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Money,
  PageIntro,
  formatDate,
} from '@/components/ViewHelpers';
import {
  guessColumn,
  parseMoney,
  readWorkbook,
  type FileProfile,
} from '@/lib/workbook';
import type { CollectionRow } from '@/types/reconciliation';

export default function CollectionsPage() {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<CollectionRow | null>(null);
  const query = useQuery({
    queryKey: ['collections'],
    queryFn: reconciliationApi.collections,
  });
  const rows = query.data ?? [];
  const filtered = useMemo(
    () =>
      rows.filter(({ job }) =>
        `${job.taskNo} ${job.mallName} ${job.storeName} ${job.storeCode}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [rows, search],
  );
  const stats = useMemo(
    () => ({
      total: rows.length,
      matched: rows.filter((row) => row.collection.status === 'matched').length,
      pendingAmount: rows.reduce(
        (sum, row) =>
          sum +
          Math.max(
            0,
            Number(row.collection.expectedAmount) -
              Number(row.collection.receivedAmount),
          ),
        0,
      ),
      overdue: rows.filter((row) => row.collection.status === 'overdue').length,
    }),
    [rows],
  );

  if (query.isLoading) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error?.message} />;

  return (
    <div className="page-stack">
      <PageIntro
        title="回款管理"
        description="对账任务通过后形成应收回款计划，银行流水导入后自动核销并识别少到、晚到和多到。"
      />
      <section className="metric-grid">
        <article className="metric-card">
          <span className="metric-icon neutral">
            <Landmark size={19} />
          </span>
          <div>
            <p>回款计划</p>
            <strong>{stats.total}</strong>
            <small>来自已导入对账任务</small>
          </div>
        </article>
        <article className="metric-card">
          <span className="metric-icon success">
            <CheckCircle2 size={19} />
          </span>
          <div>
            <p>已核销</p>
            <strong>{stats.matched}</strong>
            <small>金额在容忍值内</small>
          </div>
        </article>
        <article className="metric-card">
          <span className="metric-icon warning">
            <AlertTriangle size={19} />
          </span>
          <div>
            <p>逾期少到</p>
            <strong>{stats.overdue}</strong>
            <small>按到期日判断</small>
          </div>
        </article>
        <article className="metric-card">
          <span className="metric-icon danger">
            <Landmark size={19} />
          </span>
          <div>
            <p>待回款金额</p>
            <strong className="metric-money">
              <Money value={stats.pendingAmount} />
            </strong>
            <small>应收减已收</small>
          </div>
        </article>
      </section>

      <div className="toolbar-row">
        <label className="search-box">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索商场、门店或任务号"
          />
        </label>
      </div>

      <section className="section-block">
        <div className="section-heading">
          <div>
            <h3>回款计划</h3>
            <p>每条计划对应一笔商场结算对账任务</p>
          </div>
          <span className="section-count">{filtered.length} 条</span>
        </div>
        {filtered.length === 0 ? (
          <EmptyState
            title="暂无回款计划"
            description="先导入并创建对账任务，系统会自动生成待回款计划。"
          />
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>商场 / 门店</th>
                  <th>账期</th>
                  <th>应收</th>
                  <th>已收</th>
                  <th>差额</th>
                  <th>到期日</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr key={row.collection.id}>
                    <td>
                      <strong>{row.job.mallName}</strong>
                      <small>
                        {row.job.storeName} / {row.job.storeCode}
                      </small>
                    </td>
                    <td>
                      {row.job.periodStart}
                      <small>至 {row.job.periodEnd}</small>
                    </td>
                    <td>
                      <Money value={row.collection.expectedAmount} />
                    </td>
                    <td>
                      <Money value={row.collection.receivedAmount} />
                      {row.receipts.length > 0 && (
                        <small>{row.receipts.length} 条流水</small>
                      )}
                    </td>
                    <td
                      className={
                        Number(row.collection.differenceAmount) === 0
                          ? ''
                          : 'danger-text'
                      }
                    >
                      <Money value={row.collection.differenceAmount} signed />
                    </td>
                    <td>{row.collection.dueDate ?? '未设置'}</td>
                    <td>
                      <span className={`status-badge status-${row.collection.status}`}>
                        {collectionStatusLabel(row.collection.status)}
                      </span>
                      {row.voucherBlocked && <small>异常未完结，暂不生成草稿</small>}
                    </td>
                    <td>
                      <button
                        className="button secondary compact"
                        onClick={() => setSelected(row)}
                      >
                        <FileUp size={15} />
                        导入流水
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <ReceiptImportDialog row={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function ReceiptImportDialog({
  row,
  onClose,
}: {
  row: CollectionRow | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [profile, setProfile] = useState<FileProfile | null>(null);
  const [dueDate, setDueDate] = useState('');
  const [mapping, setMapping] = useState({
    paymentDate: '',
    payerName: '',
    bankReference: '',
    paymentAmount: '',
  });
  const mutation = useMutation({
    mutationFn: (input: ImportReceiptsInput) =>
      reconciliationApi.importReceipts(row?.job.id ?? '', input),
    onSuccess: () => {
      toast.success('回款流水已导入并完成核销');
      onClose();
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['collections'] }),
        queryClient.invalidateQueries({ queryKey: ['vouchers'] }),
        queryClient.invalidateQueries({ queryKey: ['job', row?.job.id] }),
      ]);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : '导入失败'),
  });

  if (!row) return null;

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const nextProfile = await readWorkbook(file);
      setProfile(nextProfile);
      setDueDate(row.collection.dueDate ?? '');
      setMapping({
        paymentDate: guessColumn(nextProfile.headers, 'paymentDate'),
        payerName: guessColumn(nextProfile.headers, 'payerName'),
        bankReference: guessColumn(nextProfile.headers, 'bankReference'),
        paymentAmount: guessColumn(nextProfile.headers, 'paymentAmount'),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '文件读取失败');
    }
  };

  const rows = profile?.rows ?? [];
  const validRows = rows.filter(
    (item) =>
      mapping.paymentDate &&
      mapping.payerName &&
      mapping.bankReference &&
      mapping.paymentAmount &&
      parseMoney(item[mapping.paymentAmount]) > 0,
  );
  const amount = validRows.reduce(
    (sum, item) => sum + parseMoney(item[mapping.paymentAmount]),
    0,
  );

  const submit = () => {
    if (!profile) return;
    if (!mapping.paymentDate || !mapping.payerName || !mapping.paymentAmount) {
      toast.error('请确认到账日期、付款方和到账金额映射');
      return;
    }
    mutation.mutate({
      sourceFileName: profile.fileName,
      dueDate: dueDate || undefined,
      receipts: validRows.map((item, index) => ({
        paymentDate: String(item[mapping.paymentDate] ?? ''),
        payerName: String(item[mapping.payerName] ?? ''),
        bankReference: String(
          item[mapping.bankReference] ?? `BANK-${index + 1}`,
        ),
        amount: parseMoney(item[mapping.paymentAmount]),
        note: '',
      })),
    });
  };

  return (
    <div className="dialog-backdrop">
      <section className="small-dialog">
        <div className="dialog-header">
          <div>
            <p className="topbar-kicker">导入银行流水</p>
            <h2>{row.job.mallName} 回款核销</h2>
          </div>
          <button className="icon-button" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="dialog-body form-stack">
          <div className="collection-summary">
            <span>
              应收 <strong><Money value={row.collection.expectedAmount} /></strong>
            </span>
            <span>
              已收 <strong><Money value={row.collection.receivedAmount} /></strong>
            </span>
            <span>
              本次识别 <strong><Money value={amount} /></strong>
            </span>
          </div>
          <div className="form-grid two">
            <label>
              到期日
              <input
                type="date"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
              />
            </label>
            <label className="file-picker">
              银行流水文件
              <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} />
            </label>
          </div>
          {profile && (
            <>
              <div className="form-grid two">
                <FieldSelect
                  label="到账日期"
                  value={mapping.paymentDate}
                  headers={profile.headers}
                  onChange={(value) =>
                    setMapping((prev) => ({ ...prev, paymentDate: value }))
                  }
                />
                <FieldSelect
                  label="付款方"
                  value={mapping.payerName}
                  headers={profile.headers}
                  onChange={(value) =>
                    setMapping((prev) => ({ ...prev, payerName: value }))
                  }
                />
                <FieldSelect
                  label="银行流水号"
                  value={mapping.bankReference}
                  headers={profile.headers}
                  onChange={(value) =>
                    setMapping((prev) => ({ ...prev, bankReference: value }))
                  }
                />
                <FieldSelect
                  label="到账金额"
                  value={mapping.paymentAmount}
                  headers={profile.headers}
                  onChange={(value) =>
                    setMapping((prev) => ({ ...prev, paymentAmount: value }))
                  }
                />
              </div>
              <div className="mini-table">
                <table>
                  <thead>
                    <tr>
                      <th>到账日期</th>
                      <th>付款方</th>
                      <th>流水号</th>
                      <th>金额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {validRows.slice(0, 5).map((item, index) => (
                      <tr key={index}>
                        <td>{String(item[mapping.paymentDate] ?? '')}</td>
                        <td>{String(item[mapping.payerName] ?? '')}</td>
                        <td>{String(item[mapping.bankReference] ?? '')}</td>
                        <td>
                          <Money value={parseMoney(item[mapping.paymentAmount])} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
        <div className="dialog-footer">
          <button className="button secondary" onClick={onClose}>
            取消
          </button>
          <button
            className="button primary"
            disabled={!profile || mutation.isPending}
            onClick={submit}
          >
            导入并核销
          </button>
        </div>
      </section>
    </div>
  );
}

function FieldSelect({
  label,
  value,
  headers,
  onChange,
}: {
  label: string;
  value: string;
  headers: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">不映射</option>
        {headers.map((header) => (
          <option key={header} value={header}>
            {header}
          </option>
        ))}
      </select>
    </label>
  );
}

function collectionStatusLabel(status: string) {
  return (
    {
      pending: '待回款',
      partial: '部分回款',
      matched: '已核销',
      overpaid: '多到款',
      overdue: '逾期少到',
    }[status] ?? status
  );
}
