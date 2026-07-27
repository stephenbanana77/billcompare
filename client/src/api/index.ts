import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type { AxiosRequestConfig } from 'axios';
import type {
  CreateJobInput,
  CreateEmailSourceInput,
  CreateRuleInput,
  ImportReceiptsInput,
  ResolveIssueInput,
  SyncEmailSourceInput,
  UpdateVoucherInput,
  VisionExtractionResult,
  VisionRefinementCandidate,
  VisionRefinementResult,
  OcrExtractionResult,
} from '@shared/reconciliation';
import type {
  CollectionRow,
  DashboardData,
  JobDetail,
  ReconciliationIssueRow,
  ReconciliationIssueEvent,
  InboundEmailRow,
  ReconciliationEmailSource,
  ReconciliationJob,
  ReconciliationMappingTemplate,
  ReconciliationRule,
  ReconciliationVoucher,
  VoucherRow,
} from '@/types/reconciliation';

const now = '2026-07-22T09:30:00.000Z';
const demoJobs: ReconciliationJob[] = [
  {
    id: 'demo-job-001',
    taskNo: 'REC-20260722-A001',
    mallName: '商场A',
    storeName: '中心店',
    storeCode: 'ST001',
    periodStart: '2026-06-01',
    periodEnd: '2026-06-30',
    status: 'needs_review',
    billType: 'standard',
    sourceBillName: '商场A_6月结算单.xlsx',
    sourceErpName: 'ERP_ST001_6月销售.csv',
    ruleId: 'demo-rule-001',
    ruleSnapshot: {
      name: '商场A 标准扣点月结',
      commissionRate: 12,
      activityFee: 0,
      toleranceAmount: 1,
      periodType: 'calendar_month',
    },
    billSnapshot: {
      salesAmount: 100000,
      refundAmount: 5000,
      commissionAmount: 11800,
      activityFee: 0,
      settlementAmount: 83200,
      periodStart: '2026-06-01',
      periodEnd: '2026-06-30',
    },
    erpSnapshot: {
      salesAmount: 100000,
      refundAmount: 5000,
      rowCount: 186,
      includedRowCount: 180,
      dateColumn: '交易日期',
      periodStart: '2026-06-01',
      periodEnd: '2026-06-30',
    },
    salesDiff: '0.00',
    refundDiff: '0.00',
    settlementDiff: '-400.00',
    issueCount: 1,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'demo-job-002',
    taskNo: 'REC-20260722-B002',
    mallName: '商场B',
    storeName: '旗舰店',
    storeCode: 'ST-C02',
    periodStart: '2026-06-01',
    periodEnd: '2026-06-30',
    status: 'matched',
    billType: 'complex',
    sourceBillName: 'MallB_settlement_june.pdf',
    sourceErpName: 'erp_export_june.xlsx',
    ruleId: 'demo-rule-002',
    ruleSnapshot: {
      name: '商场B 扣点与活动费',
      commissionRate: 10,
      activityFee: 2000,
      toleranceAmount: 1,
      periodType: 'calendar_month',
    },
    billSnapshot: {
      salesAmount: 120000,
      refundAmount: 3000,
      commissionAmount: 11700,
      activityFee: 2000,
      settlementAmount: 103300,
      periodStart: '2026-06-01',
      periodEnd: '2026-06-30',
    },
    erpSnapshot: {
      salesAmount: 120000,
      refundAmount: 3000,
      rowCount: 240,
      includedRowCount: 240,
      dateColumn: '记账日',
      periodStart: '2026-06-01',
      periodEnd: '2026-06-30',
    },
    salesDiff: '0.00',
    refundDiff: '0.00',
    settlementDiff: '0.00',
    issueCount: 0,
    createdAt: now,
    updatedAt: now,
  },
];

const demoIssues: ReconciliationIssueRow[] = [
  {
    issue: {
      id: 'demo-issue-001',
      jobId: 'demo-job-001',
      type: 'commission_difference',
      severity: 'medium',
      title: '扣点金额差异 多计 ¥400.00',
      description: '商场账单扣点为 ¥11800.00，系统依据 ERP 与规则计算为 ¥11400.00。',
      differenceAmount: '400.00',
      status: 'open',
      suggestedAction: '复核扣点比例及计提基数，必要时依据合同向商场发起申诉。',
      resolutionNote: null,
      resolutionEvidence: null,
      assignedTo: null,
      dueDate: '2026-07-24',
      reviewerName: null,
      reviewNote: null,
      reviewedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    job: demoJobs[0],
  },
];

const demoCollections: CollectionRow[] = [
  {
    collection: {
      id: 'demo-collection-001',
      jobId: 'demo-job-001',
      expectedAmount: '83200.00',
      dueDate: '2026-07-25',
      receivedAmount: '0.00',
      differenceAmount: '-83200.00',
      status: 'pending',
      lastReceiptAt: null,
      createdAt: now,
      updatedAt: now,
    },
    job: demoJobs[0],
    receipts: [],
    voucher: null,
    voucherBlocked: false,
  },
  {
    collection: {
      id: 'demo-collection-002',
      jobId: 'demo-job-002',
      expectedAmount: '103300.00',
      dueDate: '2026-07-20',
      receivedAmount: '103300.00',
      differenceAmount: '0.00',
      status: 'matched',
      lastReceiptAt: '2026-07-18',
      createdAt: now,
      updatedAt: now,
    },
    job: demoJobs[1],
    receipts: [
      {
        id: 'demo-receipt-001',
        collectionId: 'demo-collection-002',
        sourceFileName: '银行流水_7月.xlsx',
        bankReference: 'BANK-20260718-001',
        payerName: '商场B',
        paymentDate: '2026-07-18',
        amount: '103300.00',
        note: null,
        createdAt: now,
      },
    ],
    voucher: null,
    voucherBlocked: false,
  },
];

const demoVoucher: VoucherRow = {
  voucher: {
    id: 'demo-voucher-001',
    jobId: 'demo-job-002',
    collectionId: 'demo-collection-002',
    voucherNo: 'VCH-20260718-B002',
    status: 'draft',
    voucherDate: '2026-07-18',
    summary: '商场B 2026-06-01至2026-06-30 商场结算回款',
    totalAmount: '103300.00',
    debitAccount: '银行存款',
    creditAccount: '应收账款-商场',
    lines: [
      {
        direction: 'debit',
        account: '银行存款',
        amount: 103300,
        summary: '商场B 2026-06-01至2026-06-30 商场结算回款',
      },
      {
        direction: 'credit',
        account: '应收账款-商场',
        amount: 103300,
        summary: '商场B 2026-06-01至2026-06-30 商场结算回款',
      },
    ],
    confirmedBy: null,
    confirmedAt: null,
    createdAt: now,
    updatedAt: now,
  },
  job: demoJobs[1],
  collection: demoCollections[1].collection,
};

function localFallback<T>(config: AxiosRequestConfig): T | undefined {
  if (!location.hostname.match(/^(127\.0\.0\.1|localhost)$/)) return undefined;
  const url = String(config.url ?? '');
  if (url.endsWith('/dashboard')) {
    return {
      totalJobs: 2,
      matchedJobs: 1,
      reviewJobs: 1,
      resolvedJobs: 0,
      openIssues: 1,
      differenceAmount: 400,
      matchRate: 50,
      recentJobs: demoJobs,
    } as T;
  }
  if (url.endsWith('/jobs/demo-job-001')) {
    return {
      job: demoJobs[0],
      comparisons: [
        ['销售额', '100000.00', '100000.00', '0.00', 'matched'],
        ['退款金额', '5000.00', '5000.00', '0.00', 'matched'],
        ['扣点金额', '11800.00', '11400.00', '400.00', 'difference'],
        ['活动费', '0.00', '0.00', '0.00', 'matched'],
        ['实结金额', '83200.00', '83600.00', '-400.00', 'difference'],
      ].map(([fieldLabel, billValue, erpValue, difference, result], index) => ({
        id: `demo-comparison-${index}`,
        jobId: 'demo-job-001',
        fieldKey: String(index),
        fieldLabel,
        billValue,
        erpValue,
        difference,
        result,
        evidence: {},
        sortOrder: index + 1,
      })),
      issues: demoIssues.map((row) => row.issue),
      auditLogs: [
        {
          id: 'demo-audit-001',
          action: 'job_created',
          detail: {},
          operatorName: '系统',
          createdAt: now,
        },
      ],
    } as T;
  }
  if (url.endsWith('/jobs/demo-job-002')) {
    return {
      job: demoJobs[1],
      comparisons: [],
      issues: [],
      auditLogs: [],
    } as T;
  }
  if (url.endsWith('/jobs')) return demoJobs as T;
  if (url.endsWith('/issues')) return demoIssues as T;
  if (url.endsWith('/collections')) return demoCollections as T;
  if (url.endsWith('/vouchers')) return [demoVoucher] as T;
  if (url.endsWith('/rules')) {
    return [
      {
        id: 'demo-rule-001',
        name: '商场A 标准扣点月结',
        mallName: '商场A',
        storeCode: null,
        contractNo: 'HT-MALL-A-2026',
        contractVersion: 'V1.0',
        effectiveStart: '2026-01-01',
        effectiveEnd: '2026-12-31',
        billType: 'standard',
        periodType: 'calendar_month',
        commissionRate: '12.00',
        activityFee: '0.00',
        toleranceAmount: '1.00',
        enabled: true,
        approvalStatus: 'approved',
        notes: '本地预览兜底数据',
        createdAt: now,
        updatedAt: now,
      },
    ] as T;
  }
  if (url.endsWith('/mapping-templates')) return [] as T;
  if (url.endsWith('/email-sources')) return [] as T;
  if (url.endsWith('/inbound-emails')) return [] as T;
  if (url.includes('/events')) return [] as T;
  return undefined;
}

async function request<T>(config: AxiosRequestConfig): Promise<T> {
  try {
    const response = await axiosForBackend(config);
    const payload = response.data as { data?: T } | T;
    return (
      payload && typeof payload === 'object' && 'data' in payload
        ? payload.data
        : payload
    ) as T;
  } catch (error) {
    const fallback = localFallback<T>(config);
    if (fallback !== undefined) return fallback;
    const response = (error as { response?: { data?: { error?: { message?: string } } } })?.response;
    const message = response?.data?.error?.message;
    throw new Error(message || (error instanceof Error ? error.message : '请求失败'));
  }
}

export const reconciliationApi = {
  extractVisionBill: (fileName: string, pages: File[]) => {
    const formData = new FormData();
    formData.append('fileName', fileName);
    pages.forEach((page) => formData.append('pages', page));
    return request<VisionExtractionResult>({
      url: '/api/reconciliation/vision-extractions',
      method: 'POST',
      data: formData,
    });
  },
  extractOcrBill: (pages: File[]) => {
    const formData = new FormData();
    pages.forEach((page) => formData.append('pages', page));
    return request<OcrExtractionResult>({
      url: '/api/reconciliation/ocr-extractions',
      method: 'POST',
      data: formData,
    });
  },
  refineVisionBill: (candidates: VisionRefinementCandidate[], tiles: File[]) => {
    const formData = new FormData();
    formData.append('candidates', JSON.stringify(candidates));
    tiles.forEach((tile) => formData.append('tiles', tile));
    return request<VisionRefinementResult>({
      url: '/api/reconciliation/vision-refinements',
      method: 'POST',
      data: formData,
    });
  },
  emailSources: () =>
    request<ReconciliationEmailSource[]>({
      url: '/api/reconciliation/email-sources',
      method: 'GET',
    }),
  createEmailSource: (input: CreateEmailSourceInput) =>
    request<ReconciliationEmailSource>({
      url: '/api/reconciliation/email-sources',
      method: 'POST',
      data: input,
    }),
  syncEmailSource: (id: string, input: SyncEmailSourceInput) =>
    request<{ imported: number; duplicates: number }>({
      url: `/api/reconciliation/email-sources/${id}/sync`,
      method: 'POST',
      data: input,
    }),
  inboundEmails: () =>
    request<InboundEmailRow[]>({
      url: '/api/reconciliation/inbound-emails',
      method: 'GET',
    }),
  updateInboundEmail: (
    id: string,
    input: { status: 'accepted' | 'ignored'; rejectionReason?: string },
  ) =>
    request({
      url: `/api/reconciliation/inbound-emails/${id}`,
      method: 'PATCH',
      data: input,
    }),
  dashboard: () =>
    request<DashboardData>({
      url: '/api/reconciliation/dashboard',
      method: 'GET',
    }),
  jobs: () =>
    request<ReconciliationJob[]>({
      url: '/api/reconciliation/jobs',
      method: 'GET',
    }),
  job: (id: string) =>
    request<JobDetail>({
      url: `/api/reconciliation/jobs/${id}`,
      method: 'GET',
    }),
  createJob: (input: CreateJobInput) =>
    request<JobDetail>({
      url: '/api/reconciliation/jobs',
      method: 'POST',
      data: input,
    }),
  deleteJob: (id: string) =>
    request<{ deleted: boolean }>({
      url: `/api/reconciliation/jobs/${id}`,
      method: 'DELETE',
    }),
  collections: () =>
    request<CollectionRow[]>({
      url: '/api/reconciliation/collections',
      method: 'GET',
    }),
  importReceipts: (jobId: string, input: ImportReceiptsInput) =>
    request<CollectionRow>({
      url: `/api/reconciliation/jobs/${jobId}/receipts`,
      method: 'POST',
      data: input,
    }),
  vouchers: () =>
    request<VoucherRow[]>({
      url: '/api/reconciliation/vouchers',
      method: 'GET',
    }),
  updateVoucher: (id: string, input: UpdateVoucherInput) =>
    request<ReconciliationVoucher>({
      url: `/api/reconciliation/vouchers/${id}`,
      method: 'PATCH',
      data: input,
    }),
  issues: () =>
    request<ReconciliationIssueRow[]>({
      url: '/api/reconciliation/issues',
      method: 'GET',
    }),
  updateIssue: (id: string, input: ResolveIssueInput) =>
    request({
      url: `/api/reconciliation/issues/${id}`,
      method: 'PATCH',
      data: input,
    }),
  issueEvents: (id: string) =>
    request<ReconciliationIssueEvent[]>({
      url: `/api/reconciliation/issues/${id}/events`,
      method: 'GET',
    }),
  rules: () =>
    request<ReconciliationRule[]>({
      url: '/api/reconciliation/rules',
      method: 'GET',
    }),
  createRule: (input: CreateRuleInput) =>
    request<ReconciliationRule>({
      url: '/api/reconciliation/rules',
      method: 'POST',
      data: input,
    }),
  updateRule: (id: string, input: CreateRuleInput) =>
    request<ReconciliationRule>({
      url: `/api/reconciliation/rules/${id}`,
      method: 'PUT',
      data: input,
    }),
  deleteRule: (id: string) =>
    request<{ deleted: boolean }>({
      url: `/api/reconciliation/rules/${id}`,
      method: 'DELETE',
    }),
  mappingTemplates: () =>
    request<ReconciliationMappingTemplate[]>({
      url: '/api/reconciliation/mapping-templates',
      method: 'GET',
    }),
  deleteMappingTemplate: (id: string) =>
    request<{ deleted: boolean }>({
      url: `/api/reconciliation/mapping-templates/${id}`,
      method: 'DELETE',
    }),
};
