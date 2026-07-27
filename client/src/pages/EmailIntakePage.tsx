import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, KeyRound, MailPlus, Paperclip, Plus, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import type { CreateEmailSourceInput } from '@shared/reconciliation';
import { reconciliationApi } from '@/api';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageIntro,
  formatDate,
} from '@/components/ViewHelpers';
import type { InboundEmailRow, ReconciliationEmailSource } from '@/types/reconciliation';

const emptySource: CreateEmailSourceInput = {
  name: '',
  provider: 'qq_mail',
  mailboxAddress: '',
  mailboxFolder: '账单待处理',
  routingRule: '',
};

const sourceStatusLabel: Record<string, string> = {
  awaiting_authorization: '待授权',
  connected: '已连接',
  paused: '已暂停',
  error: '连接异常',
};

const emailStatusLabel: Record<string, string> = {
  pending_confirmation: '待确认',
  accepted: '已接收',
  ignored: '已忽略',
  error: '处理失败',
};

export default function EmailIntakePage() {
  const [creating, setCreating] = useState(false);
  const [selectedEmail, setSelectedEmail] = useState<InboundEmailRow | null>(null);
  const [syncingSource, setSyncingSource] = useState<ReconciliationEmailSource | null>(null);
  const queryClient = useQueryClient();
  const sourcesQuery = useQuery({
    queryKey: ['email-sources'],
    queryFn: reconciliationApi.emailSources,
  });
  const emailsQuery = useQuery({
    queryKey: ['inbound-emails'],
    queryFn: reconciliationApi.inboundEmails,
  });
  if (sourcesQuery.isLoading || emailsQuery.isLoading) return <LoadingState />;
  if (sourcesQuery.isError || emailsQuery.isError) {
    return <ErrorState message={sourcesQuery.error?.message || emailsQuery.error?.message} />;
  }
  const sources = sourcesQuery.data ?? [];
  const emails = emailsQuery.data ?? [];
  const pendingCount = emails.filter((row) => row.email.status === 'pending_confirmation').length;

  return (
    <div className="page-stack">
      <PageIntro
        title="邮件接入中心"
        description="账单邮件进入待确认队列后，系统按附件类型分类、去重并保留邮件来源；确认接收后作为对账导入的可追溯来源。"
        actions={
          <button className="button primary" onClick={() => setCreating(true)}>
            <Plus size={17} /> 新建邮件来源
          </button>
        }
      />
      <div className="metric-grid email-metric-grid">
        <div className="metric-card"><span>已配置来源</span><strong>{sources.length}</strong></div>
        <div className="metric-card"><span>待确认邮件</span><strong>{pendingCount}</strong></div>
        <div className="metric-card"><span>已接收附件</span><strong>{emails.reduce((sum, row) => sum + row.email.attachments.length, 0)}</strong></div>
      </div>
      <section className="section-block">
        <div className="section-heading">
          <div>
            <h3>邮件来源</h3>
            <p>系统仅同步配置的账单文件夹，不读取收件箱中的其他邮件。</p>
          </div>
        </div>
        {sources.length === 0 ? (
          <EmptyState
            title="还没有配置邮件来源"
            description="先配置用于接收商场账单的邮箱和账单文件夹。系统不会读取未授权的邮箱内容。"
            action={<button className="button primary" onClick={() => setCreating(true)}><MailPlus size={16} /> 配置邮箱来源</button>}
          />
        ) : (
          <div className="email-source-grid">
            {sources.map((source) => <SourceCard key={source.id} source={source} onSync={() => setSyncingSource(source)} />)}
          </div>
        )}
      </section>
      <section className="section-block">
        <div className="section-heading">
          <div>
            <h3>收件待确认队列</h3>
            <p>支持 Excel、CSV 和可复制文字的 PDF；不相关或重复邮件不会直接进入对账。</p>
          </div>
          <span className="section-count">{pendingCount} 封待确认</span>
        </div>
        {emails.length === 0 ? (
          <EmptyState title="尚未收到邮件附件" description="完成邮箱授权并启用接收适配器后，符合规则的账单邮件会出现在这里。" />
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>邮件主题 / 发件人</th><th>来源</th><th>附件</th><th>收件时间</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>
                {emails.map(({ email, source }) => (
                  <tr key={email.id}>
                    <td><strong>{email.subject}</strong><small>{email.sender}</small></td>
                    <td>{source.name}<small>{source.mailboxAddress}</small></td>
                    <td><div className="attachment-list">{email.attachments.map((file) => <span key={file.fileName}><Paperclip size={12} /> {file.fileName}</span>)}</div></td>
                    <td>{formatDate(email.receivedAt)}</td>
                    <td><span className={`status-badge status-${email.status}`}>{emailStatusLabel[email.status]}</span></td>
                    <td>{email.status === 'pending_confirmation' ? <button className="button secondary compact" onClick={() => setSelectedEmail({ email, source })}>审核</button> : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <EmailSourceDialog open={creating} onClose={() => setCreating(false)} />
      <EmailReviewDialog row={selectedEmail} onClose={() => setSelectedEmail(null)} />
      <EmailSyncDialog source={syncingSource} onClose={() => setSyncingSource(null)} />
    </div>
  );
}

function EmailReviewDialog({ row, onClose }: { row: InboundEmailRow | null; onClose: () => void }) {
  const [decision, setDecision] = useState<'accepted' | 'ignored'>('accepted');
  const [reason, setReason] = useState('');
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => reconciliationApi.updateInboundEmail(row!.email.id, { status: decision, rejectionReason: reason }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['inbound-emails'] });
      toast.success(decision === 'accepted' ? '邮件已接收，可作为对账来源追溯' : '邮件已忽略');
      setReason('');
      onClose();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : '更新失败'),
  });
  if (!row) return null;
  return (
    <div className="dialog-backdrop"><section className="small-dialog" role="dialog" aria-modal="true">
      <header className="dialog-header"><div><p className="eyebrow">收件审核</p><h2>{row.email.subject}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
      <div className="dialog-body form-stack">
        <div className="issue-context"><strong>{row.email.sender}</strong><p>{row.email.attachments.map((item) => item.fileName).join('、')}</p></div>
        <label>处理决定<select value={decision} onChange={(e) => setDecision(e.target.value as typeof decision)}><option value="accepted">接收为对账来源</option><option value="ignored">忽略此邮件</option></select></label>
        {decision === 'ignored' && <label>忽略原因<textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：非本账期、重复发送或附件无效" /></label>}
        {decision === 'accepted' && <div className="template-status matched"><Check size={17} /><div><strong>已接收后保留完整来源记录</strong><p>后续将使用该邮件的原始附件进入对账导入；系统保留发件人、主题、收件时间和附件清单。</p></div></div>}
      </div>
      <footer className="dialog-footer"><button className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={mutation.isPending || (decision === 'ignored' && !reason.trim())} onClick={() => mutation.mutate()}><Check size={16} />{mutation.isPending ? '保存中...' : '确认处理'}</button></footer>
    </section></div>
  );
}

function EmailSyncDialog({
  source,
  onClose,
}: {
  source: ReconciliationEmailSource | null;
  onClose: () => void;
}) {
  const [authorizationCode, setAuthorizationCode] = useState('');
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      reconciliationApi.syncEmailSource(source!.id, {
        authorizationCode,
        maxMessages: 20,
      }),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['email-sources'] }),
        queryClient.invalidateQueries({ queryKey: ['inbound-emails'] }),
      ]);
      setAuthorizationCode('');
      toast.success(`同步完成：新增 ${result.imported} 封，跳过重复 ${result.duplicates} 封`);
      onClose();
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : '同步失败'),
  });
  if (!source) return null;
  return (
    <div className="dialog-backdrop">
      <section className="small-dialog" role="dialog" aria-modal="true">
        <header className="dialog-header">
          <div>
            <p className="eyebrow">QQ 邮箱同步</p>
            <h2>{source.mailboxAddress}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="dialog-body form-stack">
          <div className="template-status matched">
            <KeyRound size={17} />
            <div>
              <strong>授权码仅用于本次同步</strong>
              <p>系统不会保存授权码，只会连接“{source.mailboxFolder}”文件夹。请先在 QQ 邮箱网页端开启 IMAP/SMTP 并生成授权码。</p>
            </div>
          </div>
          <label>
            QQ 邮箱授权码
            <input
              type="password"
              autoComplete="new-password"
              value={authorizationCode}
              onChange={(e) => setAuthorizationCode(e.target.value)}
              placeholder="粘贴 QQ 邮箱生成的授权码"
            />
          </label>
          <p className="muted-copy">本次最多读取此文件夹中最近 20 封带附件邮件；邮件正文不会保存。</p>
        </div>
        <footer className="dialog-footer">
          <button className="button secondary" onClick={onClose}>取消</button>
          <button
            className="button primary"
            disabled={mutation.isPending || !authorizationCode.trim()}
            onClick={() => mutation.mutate()}
          >
            <RefreshCw size={16} />
            {mutation.isPending ? '正在同步...' : '授权并同步'}
          </button>
        </footer>
      </section>
    </div>
  );
}

function SourceCard({ source, onSync }: { source: ReconciliationEmailSource; onSync: () => void }) {
  return (
    <article className="email-source-card">
      <div className="email-source-card-head"><span className={`source-state ${source.status}`}>{sourceStatusLabel[source.status]}</span><MailPlus size={18} /></div>
      <h3>{source.name}</h3>
      <p>{source.mailboxAddress}</p>
      <dl>
        <div><dt>来源类型</dt><dd>{providerLabel(source.provider)}</dd></div>
        <div><dt>同步文件夹</dt><dd>{source.mailboxFolder}</dd></div>
        <div><dt>补充筛选</dt><dd>{source.routingRule || '不再额外筛选'}</dd></div>
      </dl>
      <footer>{source.provider === 'qq_mail' ? <button className="text-button" onClick={onSync}><RefreshCw size={14} /> 同步收件箱</button> : source.status === 'awaiting_authorization' ? '等待完成邮箱授权' : `最近同步：${source.lastSyncedAt ? formatDate(source.lastSyncedAt) : '暂无'}`}</footer>
    </article>
  );
}

function EmailSourceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form, setForm] = useState<CreateEmailSourceInput>(emptySource);
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => reconciliationApi.createEmailSource(form),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['email-sources'] });
      toast.success('邮件来源已创建，等待授权连接');
      setForm(emptySource);
      onClose();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : '创建失败'),
  });
  if (!open) return null;
  return (
    <div className="dialog-backdrop">
      <section className="small-dialog" role="dialog" aria-modal="true">
        <header className="dialog-header"><div><p className="eyebrow">邮件接入</p><h2>新建邮件来源</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
        <div className="dialog-body form-stack">
          <div className="validation-banner"><MailPlus size={17} /><div><strong>只读取指定账单文件夹</strong><p>请先在邮箱中新建账单文件夹，并用邮箱规则将账单邮件归档到该文件夹。</p></div></div>
          <label>来源名称<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：商场结算邮箱" /></label>
          <div className="form-grid two">
            <label>邮箱服务商<select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value as CreateEmailSourceInput['provider'] })}><option value="qq_mail">QQ 邮箱（现场同步）</option><option value="gmail">Gmail / Google Workspace</option><option value="feishu_mail">飞书邮箱</option><option value="microsoft_365">Microsoft 365 / Outlook</option><option value="imap">IMAP 企业邮箱</option></select></label>
            <label>接收邮箱<input type="email" value={form.mailboxAddress} onChange={(e) => setForm({ ...form, mailboxAddress: e.target.value })} placeholder="settlement@company.com" /></label>
          </div>
          <label>账单文件夹<input value={form.mailboxFolder} onChange={(e) => setForm({ ...form, mailboxFolder: e.target.value })} placeholder="例如：账单待处理" /></label>
          <label>邮件筛选规则<textarea rows={3} value={form.routingRule} onChange={(e) => setForm({ ...form, routingRule: e.target.value })} placeholder="例如：发件域名、主题关键词、指定文件名规则；留空表示先进入待识别队列" /></label>
        </div>
        <footer className="dialog-footer"><button className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={mutation.isPending || !form.name.trim() || !form.mailboxAddress.trim() || !form.mailboxFolder.trim()} onClick={() => mutation.mutate()}><Check size={16} />{mutation.isPending ? '保存中...' : '保存并等待授权'}</button></footer>
      </section>
    </div>
  );
}

function providerLabel(provider: ReconciliationEmailSource['provider']) {
  return ({ qq_mail: 'QQ 邮箱', gmail: 'Gmail / Google Workspace', feishu_mail: '飞书邮箱', microsoft_365: 'Microsoft 365', imap: 'IMAP' })[provider];
}
