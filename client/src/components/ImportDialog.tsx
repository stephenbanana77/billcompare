import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  FileSpreadsheet,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  CreateJobInput,
  FieldMapping,
  VisionExtractionResult,
} from '@shared/reconciliation';
import { reconciliationApi } from '@/api';
import { recognizeSettlementPdf } from '@/lib/settlement-pdf-recognition';
import { profileFromVisionExtraction } from '@/lib/vision-profile';
import {
  createHeaderSignature,
  filterRowsByDate,
  firstColumnValue,
  guessColumn,
  inferBillMetadata,
  inferStoreCode,
  readWorkbook,
  sumColumn,
  type FileProfile,
} from '@/lib/workbook';

type Mapping = FieldMapping;

const emptyMapping: Mapping = {
  periodStart: '',
  periodEnd: '',
  transactionDate: '',
  salesAmount: '',
  refundAmount: '',
  commissionAmount: '',
  activityFee: '',
  settlementAmount: '',
};

const billFieldLabels: Array<[keyof Mapping, string]> = [
  ['periodStart', '账期开始'],
  ['periodEnd', '账期结束'],
  ['salesAmount', '销售额'],
  ['refundAmount', '退款金额'],
  ['commissionAmount', '扣点金额'],
  ['activityFee', '活动费'],
  ['settlementAmount', '实结金额'],
];

const erpFieldLabels: Array<[keyof Mapping, string]> = [
  ['transactionDate', '交易日期'],
  ['salesAmount', '销售额'],
  ['refundAmount', '退款金额'],
];

function autoMapping(profile: FileProfile, isErp: boolean): Mapping {
  return {
    periodStart: isErp ? '' : guessColumn(profile.headers, 'periodStart'),
    periodEnd: isErp ? '' : guessColumn(profile.headers, 'periodEnd'),
    transactionDate: isErp
      ? guessColumn(profile.headers, 'transactionDate')
      : '',
    salesAmount: guessColumn(profile.headers, 'salesAmount'),
    refundAmount: guessColumn(profile.headers, 'refundAmount'),
    commissionAmount: isErp
      ? ''
      : guessColumn(profile.headers, 'commissionAmount'),
    activityFee: isErp ? '' : guessColumn(profile.headers, 'activityFee'),
    settlementAmount: isErp
      ? ''
      : guessColumn(profile.headers, 'settlementAmount'),
  };
}

export default function ImportDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [step, setStep] = useState(1);
  const [billProfile, setBillProfile] = useState<FileProfile | null>(null);
  const [erpProfile, setErpProfile] = useState<FileProfile | null>(null);
  const [billMap, setBillMap] = useState<Mapping>(emptyMapping);
  const [erpMap, setErpMap] = useState<Mapping>(emptyMapping);
  const [selectedRuleId, setSelectedRuleId] = useState('manual');
  const [ruleConfirmed, setRuleConfirmed] = useState(false);
  const [mappingTemplateId, setMappingTemplateId] = useState<string | null>(
    null,
  );
  const [saveMappingTemplate, setSaveMappingTemplate] = useState(true);
  const [mappingTemplateName, setMappingTemplateName] = useState('');
  const [resolvedTemplateKey, setResolvedTemplateKey] = useState('');
  const [resolvedContractKey, setResolvedContractKey] = useState('');
  const [detectedMetaCount, setDetectedMetaCount] = useState(0);
  const [pendingVisionFile, setPendingVisionFile] = useState<File | null>(null);
  const [visionExtraction, setVisionExtraction] =
    useState<VisionExtractionResult | null>(null);
  const [visionWarnings, setVisionWarnings] = useState<string[]>([]);
  const [visionError, setVisionError] = useState<string | null>(null);
  const [visionStatus, setVisionStatus] = useState('');
  const [isVisionRecognizing, setIsVisionRecognizing] = useState(false);
  const visionRequestId = useRef(0);
  const [meta, setMeta] = useState({
    mallName: '',
    storeName: '',
    storeCode: '',
    periodStart: '',
    periodEnd: '',
    billType: 'standard',
  });
  const [manualRule, setManualRule] = useState({
    name: '本次导入规则',
    commissionRate: '',
    activityFee: '0',
    toleranceAmount: '1',
    periodType: 'calendar_month',
  });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: rules = [] } = useQuery({
    queryKey: ['rules'],
    queryFn: reconciliationApi.rules,
    enabled: open,
  });
  const mappingTemplatesQuery = useQuery({
    queryKey: ['mapping-templates'],
    queryFn: reconciliationApi.mappingTemplates,
    enabled: open,
  });
  const mappingTemplates = mappingTemplatesQuery.data ?? [];

  const billSignature = billProfile
    ? createHeaderSignature(billProfile.headers)
    : '';
  const erpSignature = erpProfile
    ? createHeaderSignature(erpProfile.headers)
    : '';
  const matchedTemplate = mappingTemplates.find(
    (template) => template.id === mappingTemplateId,
  );

  const applicableRules = useMemo(() => {
    const normalize = (value: string | null | undefined) =>
      String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s/g, '');
    const mallName = normalize(meta.mallName);
    const storeCode = normalize(meta.storeCode);
    if (!mallName || !meta.periodStart || !meta.periodEnd) return [];
    return rules
      .filter((item) => {
        const mallMatches =
          !item.mallName || normalize(item.mallName) === mallName;
        const storeMatches =
          !item.storeCode || normalize(item.storeCode) === storeCode;
        const typeMatches = item.billType === meta.billType;
        const dateMatches =
          (!item.effectiveStart || item.effectiveStart <= meta.periodStart) &&
          (!item.effectiveEnd || item.effectiveEnd >= meta.periodEnd);
        return (
          item.enabled &&
          item.approvalStatus === 'approved' &&
          mallMatches &&
          storeMatches &&
          typeMatches &&
          dateMatches
        );
      })
      .sort((left, right) => {
        const leftScore =
          Number(Boolean(left.storeCode)) * 2 + Number(Boolean(left.mallName));
        const rightScore =
          Number(Boolean(right.storeCode)) * 2 +
          Number(Boolean(right.mallName));
        return (
          rightScore - leftScore ||
          right.updatedAt.localeCompare(left.updatedAt)
        );
      });
  }, [
    meta.billType,
    meta.mallName,
    meta.periodEnd,
    meta.periodStart,
    meta.storeCode,
    rules,
  ]);
  const autoMatchedRule = applicableRules[0];

  useEffect(() => {
    if (
      !mappingTemplatesQuery.isFetched ||
      !billProfile ||
      !erpProfile ||
      !meta.mallName.trim()
    ) {
      return;
    }
    const mallKey = meta.mallName.toLowerCase().replace(/\s/g, '');
    const templateVersion = mappingTemplates
      .map((template) => `${template.id}:${template.updatedAt}`)
      .join(',');
    const resolutionKey = `${mallKey}|${billSignature}|${erpSignature}|${templateVersion}`;
    if (resolutionKey === resolvedTemplateKey) return;
    setResolvedTemplateKey(resolutionKey);

    const template = mappingTemplates.find(
      (item) =>
        item.mallName.toLowerCase().replace(/\s/g, '') === mallKey &&
        item.billSignature === billSignature &&
        item.erpSignature === erpSignature,
    );
    if (template) {
      setBillMap(template.billMapping);
      setErpMap(template.erpMapping);
      setMappingTemplateId(template.id);
      setMappingTemplateName(template.name);
      setSaveMappingTemplate(false);
      return;
    }

    setMappingTemplateId(null);
    setMappingTemplateName(`${meta.mallName.trim()}字段映射模板`);
    setSaveMappingTemplate(true);
  }, [
    billProfile,
    billSignature,
    erpProfile,
    erpSignature,
    mappingTemplates,
    mappingTemplatesQuery.isFetched,
    meta.mallName,
    resolvedTemplateKey,
  ]);

  useEffect(() => {
    const key = [
      meta.mallName.trim().toLowerCase(),
      meta.storeCode.trim().toLowerCase(),
      meta.billType,
      meta.periodStart,
      meta.periodEnd,
      rules.map((item) => `${item.id}:${item.updatedAt}`).join(','),
    ].join('|');
    if (
      !meta.mallName ||
      !meta.periodStart ||
      !meta.periodEnd ||
      key === resolvedContractKey
    ) {
      return;
    }
    setResolvedContractKey(key);
    setSelectedRuleId(autoMatchedRule?.id ?? 'manual');
    setRuleConfirmed(false);
  }, [
    autoMatchedRule?.id,
    meta.billType,
    meta.mallName,
    meta.periodEnd,
    meta.periodStart,
    meta.storeCode,
    resolvedContractKey,
    rules,
  ]);

  const selectedRule = rules.find((rule) => rule.id === selectedRuleId);
  const rule = selectedRule
    ? {
        name: selectedRule.name,
        commissionRate: Number(selectedRule.commissionRate),
        activityFee: Number(selectedRule.activityFee),
        toleranceAmount: Number(selectedRule.toleranceAmount),
        periodType: selectedRule.periodType,
      }
    : {
        ...manualRule,
        commissionRate: Number(manualRule.commissionRate),
        activityFee: Number(manualRule.activityFee),
        toleranceAmount: Number(manualRule.toleranceAmount),
      };

  const erpFilteredRows = useMemo(
    () =>
      filterRowsByDate(
        erpProfile,
        erpMap.transactionDate,
        meta.periodStart,
        meta.periodEnd,
      ),
    [erpProfile, erpMap.transactionDate, meta.periodStart, meta.periodEnd],
  );
  const billPeriodStart = firstColumnValue(billProfile, billMap.periodStart);
  const billPeriodEnd = firstColumnValue(billProfile, billMap.periodEnd);

  const totals = useMemo(
    () => ({
      bill: {
        salesAmount: sumColumn(billProfile, billMap.salesAmount),
        refundAmount: sumColumn(billProfile, billMap.refundAmount),
        commissionAmount: sumColumn(billProfile, billMap.commissionAmount),
        activityFee: sumColumn(billProfile, billMap.activityFee),
        settlementAmount: sumColumn(billProfile, billMap.settlementAmount),
      },
      erp: {
        salesAmount: sumColumn(erpProfile, erpMap.salesAmount, erpFilteredRows),
        refundAmount: sumColumn(
          erpProfile,
          erpMap.refundAmount,
          erpFilteredRows,
        ),
      },
    }),
    [billProfile, erpProfile, billMap, erpMap, erpFilteredRows],
  );

  const expectedCommission =
    ((totals.erp.salesAmount - totals.erp.refundAmount) * rule.commissionRate) /
    100;
  const expectedSettlement =
    totals.erp.salesAmount -
    totals.erp.refundAmount -
    expectedCommission -
    rule.activityFee;
  const settlementDifference =
    totals.bill.settlementAmount - expectedSettlement;
  const billNetSales = totals.bill.salesAmount - totals.bill.refundAmount;
  const impliedCommissionRate =
    billNetSales > 0
      ? (Number(totals.bill.commissionAmount) / billNetSales) * 100
      : 0;
  const ruleDifference = totals.bill.commissionAmount - expectedCommission;
  const manualRateProvided = Boolean(
    selectedRule || manualRule.commissionRate.trim(),
  );
  const billPeriodMatches = Boolean(
    billPeriodStart &&
    billPeriodEnd &&
    billPeriodStart === meta.periodStart &&
    billPeriodEnd === meta.periodEnd,
  );
  const dynamicFieldCount = visionExtraction?.dynamicFields?.length ?? 0;
  const formulaCheckCount = visionExtraction?.formulaChecks?.length ?? 0;

  const reset = () => {
    visionRequestId.current += 1;
    setStep(1);
    setBillProfile(null);
    setErpProfile(null);
    setBillMap(emptyMapping);
    setErpMap(emptyMapping);
    setSelectedRuleId('manual');
    setRuleConfirmed(false);
    setMappingTemplateId(null);
    setSaveMappingTemplate(true);
    setMappingTemplateName('');
    setResolvedTemplateKey('');
    setResolvedContractKey('');
    setDetectedMetaCount(0);
    setPendingVisionFile(null);
    setVisionExtraction(null);
    setVisionWarnings([]);
    setVisionError(null);
    setVisionStatus('');
    setIsVisionRecognizing(false);
    setMeta({
      mallName: '',
      storeName: '',
      storeCode: '',
      periodStart: '',
      periodEnd: '',
      billType: 'standard',
    });
    setManualRule({
      name: '本次导入规则',
      commissionRate: '',
      activityFee: '0',
      toleranceAmount: '1',
      periodType: 'calendar_month',
    });
  };

  const close = () => {
    reset();
    onClose();
  };

  const handleFile = async (file: File | undefined, target: 'bill' | 'erp') => {
    if (!file) return;
    if (target === 'bill' && file.name.toLowerCase().endsWith('.pdf')) {
      visionRequestId.current += 1;
      setPendingVisionFile(file);
      setVisionExtraction(null);
      setVisionWarnings([]);
      setVisionError(null);
      setVisionStatus('');
      setIsVisionRecognizing(false);
      setBillProfile(null);
      setBillMap(emptyMapping);
      setMappingTemplateId(null);
      setResolvedTemplateKey('');
      toast.info('PDF 结算单将使用统一视觉识别流程处理。');
      return;
    }
    try {
      const profile = await readWorkbook(file);
      if (target === 'bill') {
        setPendingVisionFile(null);
        setVisionExtraction(null);
        setVisionWarnings([]);
        setVisionError(null);
        const detected = inferBillMetadata(profile);
        setBillProfile(profile);
        setBillMap(autoMapping(profile, false));
        setMeta((current) => ({
          ...current,
          ...detected,
        }));
        setDetectedMetaCount(
          [
            detected.mallName,
            detected.storeName,
            detected.storeCode,
            detected.periodStart,
            detected.periodEnd,
            detected.billType,
          ].filter(Boolean).length,
        );
      } else {
        setErpProfile(profile);
        setErpMap(autoMapping(profile, true));
        const detectedStoreCode = inferStoreCode(profile);
        if (detectedStoreCode) {
          setMeta((current) => ({
            ...current,
            storeCode: current.storeCode || detectedStoreCode,
          }));
        }
      }
      setMappingTemplateId(null);
      setResolvedTemplateKey('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '文件读取失败');
    }
  };

  const handleVisionRecognition = async () => {
    if (!pendingVisionFile) return;
    const file = pendingVisionFile;
    const requestId = visionRequestId.current + 1;
    visionRequestId.current = requestId;
    setIsVisionRecognizing(true);
    setVisionError(null);
    setVisionWarnings([]);
    try {
      const { extraction, ocrWarning } = await recognizeSettlementPdf(
        file,
        (stage) => {
          if (visionRequestId.current !== requestId) return;
          setVisionStatus(
            stage === 'rendering'
              ? '正在渲染 PDF 页面...'
              : stage === 'recognizing'
                ? '正在识别汇总字段、动态字段和明细...'
                : '正在整理识别结果...',
          );
        },
      );
      if (visionRequestId.current !== requestId) return;
      const profile = profileFromVisionExtraction(extraction);
      setBillProfile(profile);
      setBillMap(autoMapping(profile, false));
      setMeta((current) => ({ ...current, ...extraction.metadata }));
      setDetectedMetaCount(
        Object.values(extraction.metadata).filter(Boolean).length,
      );
      setVisionExtraction(extraction);
      setVisionWarnings(
        ocrWarning ? [...extraction.warnings, ocrWarning] : extraction.warnings,
      );
      setPendingVisionFile(null);
      setMappingTemplateId(null);
      setResolvedTemplateKey('');
      setVisionStatus('');
      if (ocrWarning) toast.warning(ocrWarning);
      else toast.success('统一视觉识别完成，请核对识别结果和字段映射。');
    } catch (error) {
      if (visionRequestId.current !== requestId) return;
      const message =
        error instanceof Error ? error.message : '视觉识别失败，请重试。';
      setVisionError(message);
      setVisionStatus('');
      toast.error(message);
    } finally {
      if (visionRequestId.current === requestId) {
        setIsVisionRecognizing(false);
      }
    }
  };

  const mutation = useMutation({
    mutationFn: reconciliationApi.createJob,
    onSuccess: async (data) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['jobs'] }),
        queryClient.invalidateQueries({ queryKey: ['issues'] }),
        queryClient.invalidateQueries({ queryKey: ['mapping-templates'] }),
      ]);
      close();
      toast.success('对账任务已创建');
      navigate(`/jobs/${data.job.id}`);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : '创建任务失败'),
  });

  const commit = () => {
    if (!billProfile || !erpProfile) return;
    const warnings: string[] = [];
    if (!billMap.refundAmount)
      warnings.push('商场账单未映射退款金额，当前按 0 计算。');
    if (!billMap.commissionAmount)
      warnings.push('商场账单未映射扣点金额，当前按 0 计算。');
    if (!billMap.activityFee)
      warnings.push('商场账单未映射活动费，当前按 0 计算。');
    if (!erpMap.refundAmount)
      warnings.push('ERP 文件未映射退款金额，当前按 0 计算。');
    const payload: CreateJobInput = {
      ...meta,
      sourceBillName: billProfile.fileName,
      sourceErpName: erpProfile.fileName,
      ruleId: selectedRule?.id,
      rule,
      ruleConfirmed,
      bill: totals.bill,
      erp: {
        ...totals.erp,
        rowCount: erpProfile.rows.length,
        includedRowCount: erpFilteredRows.length,
        dateColumn: erpMap.transactionDate,
        periodStart: meta.periodStart,
        periodEnd: meta.periodEnd,
      },
      importAudit: {
        billPeriodStart,
        billPeriodEnd,
        erpDateColumn: erpMap.transactionDate,
        erpRowsTotal: erpProfile.rows.length,
        erpRowsIncluded: erpFilteredRows.length,
        dateFilterApplied: true,
      },
      mappingTemplate: {
        templateId: mappingTemplateId ?? undefined,
        save: saveMappingTemplate,
        name: mappingTemplateName.trim() || `${meta.mallName}字段映射模板`,
        billSignature,
        erpSignature,
        billHeaders: billProfile.headers,
        erpHeaders: erpProfile.headers,
        billMapping: billMap,
        erpMapping: erpMap,
      },
      mappingWarnings: warnings,
    };
    mutation.mutate(payload);
  };

  if (!open) return null;
  const canLeaveStep1 = Boolean(
    meta.mallName &&
    meta.storeName &&
    meta.storeCode &&
    meta.periodStart &&
    meta.periodEnd &&
    billProfile &&
    erpProfile,
  );
  const canLeaveStep2 = Boolean(
    billMap.periodStart &&
    billMap.periodEnd &&
    billMap.salesAmount &&
    billMap.settlementAmount &&
    erpMap.transactionDate &&
    erpMap.salesAmount &&
    billPeriodMatches &&
    erpFilteredRows.length > 0,
  );

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
      >
        <header className="dialog-header">
          <div>
            <p className="eyebrow">新建对账任务</p>
            <h2 id="import-title">导入商场账单与 ERP 数据</h2>
          </div>
          <button className="icon-button" onClick={close} aria-label="关闭">
            <X size={19} />
          </button>
        </header>

        <div className="stepper" aria-label="导入步骤">
          {['基础信息', '字段映射', '规则与预览'].map((label, index) => (
            <div
              className={`step ${step >= index + 1 ? 'active' : ''}`}
              key={label}
            >
              <span>{step > index + 1 ? <Check size={14} /> : index + 1}</span>
              <strong>{label}</strong>
            </div>
          ))}
        </div>

        <div className="dialog-body">
          {step === 1 && (
            <div className="form-stack">
              <div className="upload-grid">
                <FileDrop
                  label="商场结算单"
                  profile={billProfile}
                  onFile={(file) => handleFile(file, 'bill')}
                />
                <FileDrop
                  label="ERP / POS 导出"
                  profile={erpProfile}
                  onFile={(file) => handleFile(file, 'erp')}
                />
              </div>
              {pendingVisionFile && (
                <div className="metadata-detected">
                  <AlertTriangle size={18} />
                  <div>
                    <strong>已选择 PDF 结算单：{pendingVisionFile.name}</strong>
                    <p>
                      此入口与“结算单识别”共用动态字段、明细和公式识别流程，结果仍需人工核对。
                    </p>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={handleVisionRecognition}
                      disabled={isVisionRecognizing}
                    >
                      {isVisionRecognizing
                        ? visionStatus || '正在进行统一视觉识别...'
                        : visionError
                          ? '重试统一视觉识别'
                          : '开始统一视觉识别'}
                    </button>
                  </div>
                </div>
              )}
              {visionError && (
                <div className="validation-banner error">
                  <AlertTriangle size={17} />
                  <div>
                    <strong>视觉识别未完成</strong>
                    <p>{visionError} 文件已保留，可直接点击上方按钮重试。</p>
                  </div>
                </div>
              )}
              {visionWarnings.length > 0 && (
                <div className="warning-list">
                  {visionWarnings.map((warning) => (
                    <p key={warning}>
                      <AlertTriangle size={15} />
                      {warning}
                    </p>
                  ))}
                </div>
              )}
              {billProfile && (
                <div className="metadata-detected">
                  <CheckCircle2 size={18} />
                  <div>
                    <strong>已从账单预填 {detectedMetaCount} 项基础信息</strong>
                    <p>
                      请核对商场、门店、账期和账单类型，识别不准确时可直接修改。
                      {visionExtraction
                        ? ` 已并入 ${dynamicFieldCount} 个动态字段、${formulaCheckCount} 条公式校验。`
                        : ''}
                    </p>
                  </div>
                </div>
              )}
              <div className="form-grid three">
                <label>
                  商场名称
                  <input
                    value={meta.mallName}
                    onChange={(e) =>
                      setMeta({ ...meta, mallName: e.target.value })
                    }
                    placeholder="例如：商场 A"
                  />
                </label>
                <label>
                  门店名称
                  <input
                    value={meta.storeName}
                    onChange={(e) =>
                      setMeta({ ...meta, storeName: e.target.value })
                    }
                    placeholder="例如：中心店"
                  />
                </label>
                <label>
                  门店编码
                  <input
                    value={meta.storeCode}
                    onChange={(e) =>
                      setMeta({ ...meta, storeCode: e.target.value })
                    }
                    placeholder="例如：ST001"
                  />
                </label>
                <label>
                  账期开始
                  <input
                    type="date"
                    value={meta.periodStart}
                    onChange={(e) =>
                      setMeta({ ...meta, periodStart: e.target.value })
                    }
                  />
                </label>
                <label>
                  账期结束
                  <input
                    type="date"
                    value={meta.periodEnd}
                    onChange={(e) =>
                      setMeta({ ...meta, periodEnd: e.target.value })
                    }
                  />
                </label>
                <label>
                  账单类型
                  <select
                    value={meta.billType}
                    onChange={(e) =>
                      setMeta({ ...meta, billType: e.target.value })
                    }
                  >
                    <option value="standard">标准扣点</option>
                    <option value="complex">扣点与费用</option>
                    <option value="changed_format">格式变化</option>
                  </select>
                </label>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="form-stack">
              <div className="mapping-grid">
                <MappingPanel
                  title="商场结算单"
                  profile={billProfile!}
                  mapping={billMap}
                  onChange={(mapping) => {
                    setBillMap(mapping);
                    if (mappingTemplateId) setSaveMappingTemplate(true);
                  }}
                  fields={billFieldLabels}
                  requiredKeys={[
                    'periodStart',
                    'periodEnd',
                    'salesAmount',
                    'settlementAmount',
                  ]}
                />
                <MappingPanel
                  title="ERP / POS 数据"
                  profile={erpProfile!}
                  mapping={erpMap}
                  onChange={(mapping) => {
                    setErpMap(mapping);
                    if (mappingTemplateId) setSaveMappingTemplate(true);
                  }}
                  fields={erpFieldLabels}
                  requiredKeys={['transactionDate', 'salesAmount']}
                  visibleRows={
                    erpFilteredRows.length ? erpFilteredRows : erpProfile!.rows
                  }
                  rowSummary={`账期内 ${erpFilteredRows.length} / 总计 ${erpProfile!.rows.length} 行`}
                />
              </div>
              {matchedTemplate ? (
                <div className="template-status matched">
                  <Check size={17} />
                  <div>
                    <strong>已自动套用“{matchedTemplate.name}”</strong>
                    <p>
                      此模板此前使用 {matchedTemplate.useCount}{' '}
                      次；本次无需重新映射，修改字段后可同步更新模板。
                    </p>
                  </div>
                </div>
              ) : (
                <div className="template-status new">
                  <FileSpreadsheet size={17} />
                  <div>
                    <strong>首次识别到该商场的这组表头</strong>
                    <p>完成本次手工映射后，可保存为模板供下个账期自动套用。</p>
                  </div>
                </div>
              )}
              <div className="template-save-control">
                <label>
                  <input
                    type="checkbox"
                    checked={saveMappingTemplate}
                    onChange={(event) =>
                      setSaveMappingTemplate(event.target.checked)
                    }
                  />
                  {matchedTemplate
                    ? '保存本次调整并更新模板'
                    : '保存本次字段映射为模板'}
                </label>
                {saveMappingTemplate && (
                  <input
                    value={mappingTemplateName}
                    onChange={(event) =>
                      setMappingTemplateName(event.target.value)
                    }
                    placeholder="模板名称"
                  />
                )}
              </div>
              {!billPeriodMatches &&
                billMap.periodStart &&
                billMap.periodEnd && (
                  <div className="validation-banner error">
                    <AlertTriangle size={17} />
                    <div>
                      <strong>任务账期与商场账单不一致</strong>
                      <p>
                        任务填写 {meta.periodStart} 至 {meta.periodEnd}
                        ，账单记录 {billPeriodStart || '未识别'} 至{' '}
                        {billPeriodEnd || '未识别'}
                        。请返回上一步修正账期，或重新映射账期字段。
                      </p>
                    </div>
                  </div>
                )}
              {erpMap.transactionDate && erpFilteredRows.length === 0 && (
                <div className="validation-banner error">
                  <AlertTriangle size={17} />
                  <div>
                    <strong>ERP 中没有账期内数据</strong>
                    <p>当前日期范围没有匹配行，系统不会使用账期外数据计算。</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="preview-layout">
              <div className="rule-panel">
                <h3>本次计算规则</h3>
                <label>
                  选择已有规则
                  <select
                    value={selectedRuleId}
                    onChange={(e) => {
                      setSelectedRuleId(e.target.value);
                      setRuleConfirmed(false);
                    }}
                  >
                    <option value="manual">临时规则（不保存）</option>
                    {applicableRules.map((item) => (
                      <option value={item.id} key={item.id}>
                        {item.name}
                        {item.contractNo ? ` · ${item.contractNo}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                {!selectedRule && (
                  <div className="form-grid two compact">
                    <label>
                      规则名称
                      <input
                        value={manualRule.name}
                        onChange={(e) =>
                          setManualRule({ ...manualRule, name: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      账期类型
                      <select
                        value={manualRule.periodType}
                        onChange={(e) =>
                          setManualRule({
                            ...manualRule,
                            periodType: e.target.value,
                          })
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
                        step="0.01"
                        value={manualRule.commissionRate}
                        onChange={(e) => {
                          setManualRule({
                            ...manualRule,
                            commissionRate: e.target.value,
                          });
                          setRuleConfirmed(false);
                        }}
                        placeholder="必须明确填写"
                      />
                    </label>
                    <label>
                      固定活动费
                      <input
                        type="number"
                        step="0.01"
                        value={manualRule.activityFee}
                        onChange={(e) =>
                          setManualRule({
                            ...manualRule,
                            activityFee: e.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      差异容忍值
                      <input
                        type="number"
                        step="0.01"
                        value={manualRule.toleranceAmount}
                        onChange={(e) =>
                          setManualRule({
                            ...manualRule,
                            toleranceAmount: e.target.value,
                          })
                        }
                      />
                    </label>
                  </div>
                )}
                <div
                  className={`rule-check ${Math.abs(ruleDifference) > rule.toleranceAmount ? 'warning' : 'ok'}`}
                >
                  <div>
                    <strong>
                      {selectedRule ? '合同规则已匹配' : '扣点口径核对'}
                    </strong>
                    <p>
                      {selectedRule
                        ? `${selectedRule.contractNo || '未编号合同'}${selectedRule.contractVersion ? ` ${selectedRule.contractVersion}` : ''}，${selectedRule.effectiveStart || '起始不限'} 至 ${selectedRule.effectiveEnd || '结束不限'}。`
                        : ''}{' '}
                      账单金额推算约 {impliedCommissionRate.toFixed(2)}
                      %，当前规则为{' '}
                      {manualRateProvided
                        ? `${rule.commissionRate}%`
                        : '未填写'}
                      。
                    </p>
                  </div>
                  {!selectedRule && impliedCommissionRate > 0 && (
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => {
                        setManualRule({
                          ...manualRule,
                          commissionRate: impliedCommissionRate.toFixed(4),
                        });
                        setRuleConfirmed(false);
                      }}
                    >
                      采用推算值
                    </button>
                  )}
                </div>
                <label className="rule-confirmation">
                  <input
                    type="checkbox"
                    checked={ruleConfirmed}
                    onChange={(event) => setRuleConfirmed(event.target.checked)}
                  />
                  我已确认本次扣点、活动费和差异容忍值，系统将按该规则生成对账结果。
                </label>
              </div>
              <div className="preview-panel">
                <h3>计算预览</h3>
                <dl className="preview-list">
                  <div>
                    <dt>ERP 销售额</dt>
                    <dd>{formatMoney(totals.erp.salesAmount)}</dd>
                  </div>
                  <div>
                    <dt>ERP 退款</dt>
                    <dd>- {formatMoney(totals.erp.refundAmount)}</dd>
                  </div>
                  <div>
                    <dt>规则扣点</dt>
                    <dd>- {formatMoney(expectedCommission)}</dd>
                  </div>
                  <div>
                    <dt>规则活动费</dt>
                    <dd>- {formatMoney(rule.activityFee)}</dd>
                  </div>
                  <div className="total">
                    <dt>系统应结</dt>
                    <dd>{formatMoney(expectedSettlement)}</dd>
                  </div>
                  <div>
                    <dt>商场实结</dt>
                    <dd>{formatMoney(totals.bill.settlementAmount)}</dd>
                  </div>
                  <div
                    className={
                      Math.abs(settlementDifference) <= rule.toleranceAmount
                        ? 'result-ok'
                        : 'result-alert'
                    }
                  >
                    <dt>结算差异</dt>
                    <dd>{formatMoney(settlementDifference)}</dd>
                  </div>
                </dl>
              </div>
            </div>
          )}
        </div>

        <footer className="dialog-footer">
          <button
            className="button secondary"
            onClick={step === 1 ? close : () => setStep(step - 1)}
          >
            {step > 1 && <ArrowLeft size={16} />}
            {step === 1 ? '取消' : '上一步'}
          </button>
          {step < 3 ? (
            <button
              className="button primary"
              disabled={step === 1 ? !canLeaveStep1 : !canLeaveStep2}
              onClick={() => setStep(step + 1)}
            >
              下一步
              <ArrowRight size={16} />
            </button>
          ) : (
            <button
              className="button primary"
              disabled={
                mutation.isPending ||
                !rule.name ||
                !manualRateProvided ||
                !ruleConfirmed
              }
              onClick={commit}
            >
              {mutation.isPending ? '正在计算...' : '创建并计算'}
              <Check size={16} />
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function FileDrop({
  label,
  profile,
  onFile,
}: {
  label: string;
  profile: FileProfile | null;
  onFile: (file?: File) => void;
}) {
  return (
    <label className={`file-drop ${profile ? 'has-file' : ''}`}>
      <input
        type="file"
        accept=".xlsx,.xls,.csv,.pdf"
        onChange={(event) => onFile(event.target.files?.[0])}
      />
      <span className="file-icon">
        {profile ? <FileSpreadsheet size={22} /> : <Upload size={22} />}
      </span>
      <strong>{profile?.fileName ?? label}</strong>
      <small>
        {profile
          ? `${profile.sheetName} · ${profile.rows.length} 行`
          : '选择 Excel、CSV 或 PDF 文件'}
      </small>
    </label>
  );
}

function MappingPanel({
  title,
  profile,
  mapping,
  onChange,
  fields,
  requiredKeys,
  visibleRows,
  rowSummary,
}: {
  title: string;
  profile: FileProfile;
  mapping: Mapping;
  onChange: (value: Mapping) => void;
  fields: Array<[keyof Mapping, string]>;
  requiredKeys: Array<keyof Mapping>;
  visibleRows?: FileProfile['rows'];
  rowSummary?: string;
}) {
  return (
    <section className="mapping-panel">
      <div className="mapping-heading">
        <div>
          <p className="eyebrow">{profile.fileName}</p>
          <h3>{title}</h3>
        </div>
        <span>{rowSummary ?? `${profile.rows.length} 行`}</span>
      </div>
      <div className="mapping-list">
        {fields.map(([key, label]) => (
          <label key={key}>
            <span>
              {label}
              {requiredKeys.includes(key) ? <b>*</b> : ''}
            </span>
            <select
              value={mapping[key]}
              onChange={(e) => onChange({ ...mapping, [key]: e.target.value })}
            >
              <option value="">
                {['periodStart', 'periodEnd', 'transactionDate'].includes(key)
                  ? '不映射'
                  : '不映射（按 0）'}
              </option>
              {profile.headers.map((header) => (
                <option value={header} key={header}>
                  {header}
                </option>
              ))}
            </select>
            <em>
              {['periodStart', 'periodEnd', 'transactionDate'].includes(key)
                ? firstColumnValue(profile, mapping[key]) || '-'
                : formatMoney(sumColumn(profile, mapping[key], visibleRows))}
            </em>
          </label>
        ))}
      </div>
      <div className="source-preview">
        <strong>原始数据预览</strong>
        <div className="mini-table">
          <table>
            <thead>
              <tr>
                {profile.headers.map((header) => (
                  <th key={header}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(visibleRows ?? profile.rows).slice(0, 3).map((row, index) => (
                <tr key={index}>
                  {profile.headers.map((header) => (
                    <td key={header}>{String(row[header] ?? '')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function formatMoney(value: number) {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
  }).format(value || 0);
}
