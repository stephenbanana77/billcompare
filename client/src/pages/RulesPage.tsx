import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import type { CreateRuleInput } from '@shared/reconciliation';
import { reconciliationApi } from '@/api';
import ConfirmDialog from '@/components/ConfirmDialog';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Money,
  PageIntro,
  formatDate,
} from '@/components/ViewHelpers';
import type {
  ReconciliationMappingTemplate,
  ReconciliationRule,
} from '@/types/reconciliation';

const emptyRule: CreateRuleInput = {
  name: '',
  mallName: '',
  storeCode: '',
  contractNo: '',
  contractVersion: 'V1.0',
  effectiveStart: '',
  effectiveEnd: '',
  billType: 'standard',
  periodType: 'calendar_month',
  commissionRate: 0,
  activityFee: 0,
  toleranceAmount: 1,
  enabled: true,
  approvalStatus: 'approved',
  notes: '',
};

export default function RulesPage() {
  const [editing, setEditing] = useState<ReconciliationRule | 'new' | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<ReconciliationRule | null>(
    null,
  );
  const [templateDeleteTarget, setTemplateDeleteTarget] =
    useState<ReconciliationMappingTemplate | null>(null);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['rules'],
    queryFn: reconciliationApi.rules,
  });
  const templatesQuery = useQuery({
    queryKey: ['mapping-templates'],
    queryFn: reconciliationApi.mappingTemplates,
  });
  const deleteMutation = useMutation({
    mutationFn: reconciliationApi.deleteRule,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['rules'] });
      toast.success('规则已删除');
      setDeleteTarget(null);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : '删除失败'),
  });
  const deleteTemplateMutation = useMutation({
    mutationFn: reconciliationApi.deleteMappingTemplate,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['mapping-templates'] });
      toast.success('字段映射模板已删除');
      setTemplateDeleteTarget(null);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : '删除失败'),
  });
  if (query.isLoading || templatesQuery.isLoading) return <LoadingState />;
  if (query.isError || templatesQuery.isError)
    return (
      <ErrorState
        message={query.error?.message || templatesQuery.error?.message}
      />
    );
  const rules = query.data ?? [];
  const mappingTemplates = templatesQuery.data ?? [];
  return (
    <div className="page-stack">
      <PageIntro
        title="合同与结算规则中心"
        description="按商场、门店和合同有效期管理规则；仅已批准合同可在导入对账时自动匹配并生成规则快照。"
        actions={
          <button className="button primary" onClick={() => setEditing('new')}>
            <Plus size={17} />
            新建规则
          </button>
        }
      />
      <section className="section-block">
        {rules.length === 0 ? (
          <EmptyState
            title="还没有结算规则"
            description="可以先新建规则，也可以在导入时使用仅对当次任务生效的临时规则。"
            action={
              <button
                className="button primary"
                onClick={() => setEditing('new')}
              >
                <Plus size={17} />
                创建第一条规则
              </button>
            }
          />
        ) : (
          <div className="rules-grid">
            {rules.map((rule) => (
              <article className="rule-card" key={rule.id}>
                <div className="rule-card-head">
                  <div>
                    <span
                      className={
                        rule.enabled ? 'rule-state enabled' : 'rule-state'
                      }
                    >
                      {rule.enabled ? '启用' : '停用'}
                    </span>
                    <h3>{rule.name}</h3>
                    <p>
                      {rule.contractNo
                        ? `${rule.contractNo}${rule.contractVersion ? ` · ${rule.contractVersion}` : ''}`
                        : '未关联合同编号'}
                    </p>
                  </div>
                  <div className="icon-actions">
                    <button
                      className="icon-button"
                      onClick={() => setEditing(rule)}
                      aria-label="编辑规则"
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      className="icon-button danger"
                      onClick={() => setDeleteTarget(rule)}
                      aria-label="删除规则"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
                <dl className="rule-values">
                  <div>
                    <dt>适用范围</dt>
                    <dd>{`${rule.mallName || '通用商场'}${rule.storeCode ? ` / ${rule.storeCode}` : ''}`}</dd>
                  </div>
                  <div>
                    <dt>合同状态</dt>
                    <dd>{approvalLabel(rule.approvalStatus)}</dd>
                  </div>
                  <div>
                    <dt>有效期</dt>
                    <dd>
                      {rule.effectiveStart && rule.effectiveEnd
                        ? `${rule.effectiveStart} 至 ${rule.effectiveEnd}`
                        : '未限制'}
                    </dd>
                  </div>
                  <div>
                    <dt>扣点比例</dt>
                    <dd>{Number(rule.commissionRate)}%</dd>
                  </div>
                  <div>
                    <dt>固定活动费</dt>
                    <dd>
                      <Money value={rule.activityFee} />
                    </dd>
                  </div>
                  <div>
                    <dt>容忍差异</dt>
                    <dd>
                      <Money value={rule.toleranceAmount} />
                    </dd>
                  </div>
                  <div>
                    <dt>账期</dt>
                    <dd>
                      {rule.periodType === 'calendar_month'
                        ? '自然月'
                        : '非自然月'}
                    </dd>
                  </div>
                </dl>
                <footer>
                  <span>{billTypeLabel(rule.billType)}</span>
                  <small>更新于 {formatDate(rule.updatedAt)}</small>
                </footer>
              </article>
            ))}
          </div>
        )}
      </section>
      <section className="section-block">
        <div className="section-heading">
          <div>
            <h3>字段映射模板</h3>
            <p>首次确认后形成商场模板，相同表头下次自动套用。</p>
          </div>
          <span className="section-count">
            {mappingTemplates.length} 个模板
          </span>
        </div>
        {mappingTemplates.length === 0 ? (
          <EmptyState
            title="还没有字段映射模板"
            description="首次导入格式变化的账单并保存映射后，模板会出现在这里。"
          />
        ) : (
          <div className="data-table-wrap">
            <table className="data-table template-table">
              <thead>
                <tr>
                  <th>模板名称</th>
                  <th>适用商场</th>
                  <th>账单类型</th>
                  <th>字段规模</th>
                  <th>使用次数</th>
                  <th>最近使用</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {mappingTemplates.map((template) => (
                  <tr key={template.id}>
                    <td>
                      <strong>{template.name}</strong>
                      <small>精确表头匹配</small>
                    </td>
                    <td>{template.mallName}</td>
                    <td>{billTypeLabel(template.billType)}</td>
                    <td>
                      商场 {template.billHeaders.length} / ERP{' '}
                      {template.erpHeaders.length}
                    </td>
                    <td>{template.useCount}</td>
                    <td>
                      {template.lastUsedAt
                        ? formatDate(template.lastUsedAt)
                        : '尚未使用'}
                    </td>
                    <td>
                      <button
                        className="icon-button danger"
                        onClick={() => setTemplateDeleteTarget(template)}
                        aria-label={`删除映射模板 ${template.name}`}
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <RuleDialog rule={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`删除规则“${deleteTarget?.name ?? ''}”`}
        description="规则将从可选列表中移除；历史任务保存的规则快照不会受影响。"
        confirmLabel="确认删除规则"
        busy={deleteMutation.isPending}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
      />
      <ConfirmDialog
        open={Boolean(templateDeleteTarget)}
        title={`删除模板“${templateDeleteTarget?.name ?? ''}”`}
        description="删除后不会影响历史任务，但下次导入同类账单时需要重新确认字段映射。"
        confirmLabel="确认删除模板"
        busy={deleteTemplateMutation.isPending}
        onClose={() => setTemplateDeleteTarget(null)}
        onConfirm={() =>
          templateDeleteTarget &&
          deleteTemplateMutation.mutate(templateDeleteTarget.id)
        }
      />
    </div>
  );
}

function RuleDialog({
  rule,
  onClose,
}: {
  rule: ReconciliationRule | 'new' | null;
  onClose: () => void;
}) {
  const source = rule && rule !== 'new' ? rule : null;
  const makeForm = (): CreateRuleInput =>
    source
      ? {
          name: source.name,
          mallName: source.mallName ?? '',
          storeCode: source.storeCode ?? '',
          contractNo: source.contractNo ?? '',
          contractVersion: source.contractVersion ?? '',
          effectiveStart: source.effectiveStart ?? '',
          effectiveEnd: source.effectiveEnd ?? '',
          billType: source.billType,
          periodType: source.periodType,
          commissionRate: Number(source.commissionRate),
          activityFee: Number(source.activityFee),
          toleranceAmount: Number(source.toleranceAmount),
          enabled: source.enabled,
          approvalStatus: source.approvalStatus,
          notes: source.notes ?? '',
        }
      : { ...emptyRule };
  const [form, setForm] = useState<CreateRuleInput>(makeForm);
  useEffect(() => {
    if (rule) setForm(makeForm());
  }, [rule]);
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      source
        ? reconciliationApi.updateRule(source.id, form)
        : reconciliationApi.createRule(form),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['rules'] });
      toast.success(source ? '规则已更新' : '规则已创建');
      onClose();
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : '保存失败'),
  });
  if (!rule) return null;
  return (
    <div className="dialog-backdrop">
      <section className="small-dialog" role="dialog" aria-modal="true">
        <header className="dialog-header">
          <div>
            <p className="eyebrow">规则配置</p>
            <h2>{source ? '编辑结算规则' : '新建结算规则'}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="dialog-body form-stack">
          <div className="form-grid two">
            <label>
              规则名称
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例如：标准扣点月结"
              />
            </label>
            <label>
              适用商场
              <input
                value={form.mallName}
                onChange={(e) => setForm({ ...form, mallName: e.target.value })}
                placeholder="留空表示通用"
              />
            </label>
            <label>
              适用门店编码
              <input
                value={form.storeCode}
                onChange={(e) => setForm({ ...form, storeCode: e.target.value })}
                placeholder="留空表示商场全门店"
              />
            </label>
            <label>
              合同编号
              <input
                value={form.contractNo}
                onChange={(e) => setForm({ ...form, contractNo: e.target.value })}
                placeholder="例如：HT-MALL-A-2026"
              />
            </label>
            <label>
              合同版本
              <input
                value={form.contractVersion}
                onChange={(e) => setForm({ ...form, contractVersion: e.target.value })}
                placeholder="例如：V1.0"
              />
            </label>
            <label>
              生效开始日
              <input
                type="date"
                value={form.effectiveStart}
                onChange={(e) => setForm({ ...form, effectiveStart: e.target.value })}
              />
            </label>
            <label>
              生效结束日
              <input
                type="date"
                value={form.effectiveEnd}
                onChange={(e) => setForm({ ...form, effectiveEnd: e.target.value })}
              />
            </label>
            <label>
              账单类型
              <select
                value={form.billType}
                onChange={(e) => setForm({ ...form, billType: e.target.value })}
              >
                <option value="standard">标准扣点</option>
                <option value="complex">扣点与费用</option>
                <option value="changed_format">格式变化</option>
              </select>
            </label>
            <label>
              账期类型
              <select
                value={form.periodType}
                onChange={(e) =>
                  setForm({ ...form, periodType: e.target.value })
                }
              >
                <option value="calendar_month">自然月</option>
                <option value="custom_cycle">非自然月</option>
              </select>
            </label>
            <label>
              扣点比例（%）
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.commissionRate}
                onChange={(e) =>
                  setForm({ ...form, commissionRate: Number(e.target.value) })
                }
              />
            </label>
            <label>
              固定活动费
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.activityFee}
                onChange={(e) =>
                  setForm({ ...form, activityFee: Number(e.target.value) })
                }
              />
            </label>
            <label>
              容忍差异
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.toleranceAmount}
                onChange={(e) =>
                  setForm({ ...form, toleranceAmount: Number(e.target.value) })
                }
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) =>
                  setForm({ ...form, enabled: e.target.checked })
                }
              />
              启用此规则
            </label>
            <label>
              审批状态
              <select
                value={form.approvalStatus}
                onChange={(e) =>
                  setForm({
                    ...form,
                    approvalStatus: e.target.value as CreateRuleInput['approvalStatus'],
                  })
                }
              >
                <option value="draft">草稿</option>
                <option value="pending_approval">待审批</option>
                <option value="approved">已批准</option>
                <option value="disabled">已停用</option>
              </select>
            </label>
          </div>
          <label>
            备注
            <textarea
              rows={3}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="记录合同版本、费用口径或使用范围"
            />
          </label>
        </div>
        <footer className="dialog-footer">
          <button className="button secondary" onClick={onClose}>
            取消
          </button>
          <button
            className="button primary"
            disabled={mutation.isPending || !form.name.trim()}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? '保存中...' : '保存规则'}
          </button>
        </footer>
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

function approvalLabel(value: ReconciliationRule['approvalStatus']) {
  return (
    {
      draft: '草稿',
      pending_approval: '待审批',
      approved: '已批准',
      disabled: '已停用',
    }[value] ?? value
  );
}
