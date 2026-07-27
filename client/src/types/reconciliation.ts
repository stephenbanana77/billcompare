import type {
  CollectionStatus,
  CreateEmailSourceInput,
  EmailSourceStatus,
  FieldMapping,
  IssueWorkflowEvent,
  IssueStatus,
  JobStatus,
  MoneySnapshot,
  RuleSnapshot,
  RuleApprovalStatus,
  InboundEmailStatus,
  MailAttachment,
  VoucherLine,
  VoucherStatus,
} from '@shared/reconciliation';

export interface ReconciliationMappingTemplate {
  id: string;
  name: string;
  mallName: string;
  billType: string;
  billSignature: string;
  erpSignature: string;
  billHeaders: string[];
  erpHeaders: string[];
  billMapping: FieldMapping;
  erpMapping: FieldMapping;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReconciliationRule {
  id: string;
  name: string;
  mallName: string | null;
  storeCode: string | null;
  contractNo: string | null;
  contractVersion: string | null;
  effectiveStart: string | null;
  effectiveEnd: string | null;
  billType: string;
  periodType: string;
  commissionRate: string;
  activityFee: string;
  toleranceAmount: string;
  enabled: boolean;
  approvalStatus: RuleApprovalStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReconciliationJob {
  id: string;
  taskNo: string;
  mallName: string;
  storeName: string;
  storeCode: string;
  periodStart: string;
  periodEnd: string;
  status: JobStatus;
  billType: string;
  sourceBillName: string;
  sourceErpName: string;
  ruleId: string | null;
  ruleSnapshot: RuleSnapshot;
  billSnapshot: MoneySnapshot;
  erpSnapshot: MoneySnapshot;
  salesDiff: string;
  refundDiff: string;
  settlementDiff: string;
  issueCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReconciliationComparison {
  id: string;
  jobId: string;
  fieldKey: string;
  fieldLabel: string;
  billValue: string;
  erpValue: string;
  difference: string;
  result: 'matched' | 'difference';
  evidence: Record<string, unknown>;
  sortOrder: number;
}

export interface ReconciliationIssue {
  id: string;
  jobId: string;
  type: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  description: string;
  differenceAmount: string;
  status: IssueStatus;
  suggestedAction: string;
  resolutionNote: string | null;
  resolutionEvidence: string | null;
  assignedTo: string | null;
  dueDate: string | null;
  reviewerName: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ReconciliationIssueEvent = IssueWorkflowEvent;

export interface AuditLog {
  id: string;
  action: string;
  detail: Record<string, unknown>;
  operatorName: string;
  createdAt: string;
}

export interface JobDetail {
  job: ReconciliationJob;
  comparisons: ReconciliationComparison[];
  issues: ReconciliationIssue[];
  auditLogs: AuditLog[];
}

export interface ReconciliationIssueRow {
  issue: ReconciliationIssue;
  job: Pick<
    ReconciliationJob,
    'id' | 'taskNo' | 'mallName' | 'storeName' | 'periodStart' | 'periodEnd'
  >;
}

export interface DashboardData {
  totalJobs: number;
  matchedJobs: number;
  reviewJobs: number;
  resolvedJobs: number;
  openIssues: number;
  differenceAmount: number;
  matchRate: number;
  recentJobs: ReconciliationJob[];
}

export interface ReconciliationCollection {
  id: string;
  jobId: string;
  expectedAmount: string;
  dueDate: string | null;
  receivedAmount: string;
  differenceAmount: string;
  status: CollectionStatus;
  lastReceiptAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReconciliationReceipt {
  id: string;
  collectionId: string;
  sourceFileName: string;
  bankReference: string;
  payerName: string;
  paymentDate: string;
  amount: string;
  note: string | null;
  createdAt: string;
}

export interface ReconciliationVoucher {
  id: string;
  jobId: string;
  collectionId: string;
  voucherNo: string;
  status: VoucherStatus;
  voucherDate: string;
  summary: string;
  totalAmount: string;
  debitAccount: string;
  creditAccount: string;
  lines: VoucherLine[];
  confirmedBy: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReconciliationEmailSource {
  id: string;
  name: string;
  provider: CreateEmailSourceInput['provider'];
  mailboxAddress: string;
  mailboxFolder: string;
  routingRule: string | null;
  status: EmailSourceStatus;
  lastSyncedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReconciliationInboundEmail {
  id: string;
  sourceId: string;
  externalMessageId: string;
  sender: string;
  subject: string;
  receivedAt: string;
  attachments: MailAttachment[];
  status: InboundEmailStatus;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InboundEmailRow {
  email: ReconciliationInboundEmail;
  source: ReconciliationEmailSource;
}

export interface CollectionRow {
  collection: ReconciliationCollection;
  job: ReconciliationJob;
  receipts: ReconciliationReceipt[];
  voucher: ReconciliationVoucher | null;
  voucherBlocked: boolean;
}

export interface VoucherRow {
  voucher: ReconciliationVoucher;
  job: ReconciliationJob;
  collection: ReconciliationCollection;
}
