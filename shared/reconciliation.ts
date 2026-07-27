export type JobStatus = 'matched' | 'needs_review' | 'resolved';
export type IssueStatus =
  | 'open'
  | 'in_progress'
  | 'pending_approval'
  | 'resolved'
  | 'rejected';
export type ComparisonResult = 'matched' | 'difference';
export type RuleApprovalStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'disabled';
export type CollectionStatus =
  | 'pending'
  | 'partial'
  | 'matched'
  | 'overpaid'
  | 'overdue';
export type VoucherStatus = 'draft' | 'confirmed';
export type EmailSourceStatus =
  | 'awaiting_authorization'
  | 'connected'
  | 'paused'
  | 'error';
export type InboundEmailStatus =
  | 'pending_confirmation'
  | 'accepted'
  | 'ignored'
  | 'error';

export interface MailAttachment {
  fileName: string;
  mimeType?: string;
  sizeBytes?: number;
  kind: 'settlement_bill' | 'erp_export' | 'supported_pdf' | 'unsupported';
}

export interface MoneySnapshot {
  salesAmount: number;
  refundAmount: number;
  commissionAmount?: number;
  activityFee?: number;
  settlementAmount?: number;
  rowCount?: number;
  includedRowCount?: number;
  dateColumn?: string;
  periodStart?: string;
  periodEnd?: string;
}

export interface ImportAudit {
  billPeriodStart: string;
  billPeriodEnd: string;
  erpDateColumn: string;
  erpRowsTotal: number;
  erpRowsIncluded: number;
  dateFilterApplied: boolean;
}

export interface FieldMapping {
  periodStart: string;
  periodEnd: string;
  transactionDate: string;
  salesAmount: string;
  refundAmount: string;
  commissionAmount: string;
  activityFee: string;
  settlementAmount: string;
}

export type VisionFieldKey =
  | 'periodStart'
  | 'periodEnd'
  | 'salesAmount'
  | 'refundAmount'
  | 'commissionAmount'
  | 'activityFee'
  | 'invoiceAmount'
  | 'deductionTotal'
  | 'settlementAmount';

export interface VisionFieldEvidence {
  value: string | number | null;
  rawText: string | null;
  page: number | null;
  confidence: number | null;
}

export interface VisionAdditionalField extends VisionFieldEvidence {
  label: string;
  group: 'header' | 'summary' | 'fee' | 'other';
  suggestedTarget?: string | null;
}

export interface VisionLineItem {
  section: string;
  label: string;
  rowType?: 'detail' | 'adjustment' | 'subtotal' | 'total' | 'empty';
  sequence?: number | null;
  values: Record<string, string | number | null>;
  rawText: string | null;
  page: number | null;
  confidence: number | null;
}

export interface VisionRefinementCandidate {
  id: string;
  label: string;
  value: string | number | Record<string, string | number | null> | null;
  page: number | null;
}

export interface VisionRefinementItem {
  id: string;
  value: string | number | Record<string, string | number | null> | null;
  rawText: string | null;
  confidence: number | null;
  status: 'confirmed' | 'conflict' | 'unresolved';
}

export interface VisionRefinementResult {
  items: VisionRefinementItem[];
}

export type EvidencePoint = [number, number];

export interface OcrTextBox {
  page: number;
  text: string;
  score: number;
  polygon: [EvidencePoint, EvidencePoint, EvidencePoint, EvidencePoint];
}

export interface OcrPageResult {
  page: number;
  width: number;
  height: number;
  boxes: OcrTextBox[];
}

export interface OcrExtractionResult {
  engine: 'paddleocr';
  device: 'cpu' | 'gpu';
  durationMs: number;
  pages: OcrPageResult[];
  fields: Partial<Record<OcrKeyFieldKey, OcrFieldEvidence>>;
}

export type OcrKeyFieldKey =
  | 'mallName'
  | 'settlementNo'
  | 'brandMerchantName'
  | 'brandName'
  | 'storeCode'
  | 'settlementDate'
  | 'documentDate'
  | 'salesQuantity'
  | 'salesAmount'
  | 'invoiceAmount'
  | 'deductionTotal'
  | 'settlementAmount';

export interface OcrFieldEvidence {
  value: string;
  label: string;
  evidence: OcrTextBox;
}

export type RecognitionValueType = 'money' | 'date' | 'identifier' | 'text';
export type RecognitionComparisonStatus =
  | 'confirmed'
  | 'conflict'
  | 'vision_missing'
  | 'ocr_missing';

export interface RecognitionComparisonItem {
  status: RecognitionComparisonStatus;
  blocking: boolean;
  visionValue: string | number | null;
  ocrValue: string | number | null;
  normalizedVision: string | null;
  normalizedOcr: string | null;
}

export interface VisionExtractionResult {
  sourceType: 'vision_llm';
  fileName: string;
  headers: string[];
  rows: Array<Record<string, string | number>>;
  metadata: {
    mallName: string;
    storeName: string;
    storeCode: string;
    periodStart: string;
    periodEnd: string;
    billType: 'standard' | 'complex' | 'changed_format';
  };
  periodEvidence: {
    rawText: string | null;
    page: number | null;
    kind: 'explicit_range' | 'month_only' | 'inferred' | 'unknown';
  };
  evidence: Partial<Record<VisionFieldKey, VisionFieldEvidence>>;
  additionalFields: VisionAdditionalField[];
  lineItems: VisionLineItem[];
  warnings: string[];
}

export interface MappingTemplateSubmission {
  templateId?: string;
  save: boolean;
  name: string;
  billSignature: string;
  erpSignature: string;
  billHeaders: string[];
  erpHeaders: string[];
  billMapping: FieldMapping;
  erpMapping: FieldMapping;
}

export interface RuleSnapshot {
  name: string;
  commissionRate: number;
  activityFee: number;
  toleranceAmount: number;
  periodType: string;
}

export interface CreateRuleInput {
  name: string;
  mallName?: string;
  storeCode?: string;
  contractNo?: string;
  contractVersion?: string;
  effectiveStart?: string;
  effectiveEnd?: string;
  billType: string;
  periodType: string;
  commissionRate: number;
  activityFee: number;
  toleranceAmount: number;
  enabled?: boolean;
  approvalStatus?: RuleApprovalStatus;
  notes?: string;
}

export interface CreateJobInput {
  mallName: string;
  storeName: string;
  storeCode: string;
  periodStart: string;
  periodEnd: string;
  billType: string;
  sourceBillName: string;
  sourceErpName: string;
  ruleId?: string;
  rule: RuleSnapshot;
  bill: MoneySnapshot;
  erp: MoneySnapshot;
  mappingWarnings?: string[];
  ruleConfirmed: boolean;
  importAudit: ImportAudit;
  mappingTemplate: MappingTemplateSubmission;
}

export interface ResolveIssueInput {
  status: IssueStatus;
  resolutionNote?: string;
  resolutionEvidence?: string;
  assignedTo?: string;
  dueDate?: string;
  reviewNote?: string;
  reviewerName?: string;
}

export interface IssueWorkflowEvent {
  id: string;
  issueId: string;
  action: string;
  fromStatus: IssueStatus | null;
  toStatus: IssueStatus;
  comment: string | null;
  operatorName: string;
  createdAt: string;
}

export interface ReceiptInput {
  paymentDate: string;
  payerName: string;
  bankReference: string;
  amount: number;
  note?: string;
}

export interface ImportReceiptsInput {
  sourceFileName: string;
  dueDate?: string;
  receipts: ReceiptInput[];
}

export interface VoucherLine {
  direction: 'debit' | 'credit';
  account: string;
  amount: number;
  summary: string;
}

export interface UpdateVoucherInput {
  status?: VoucherStatus;
  summary?: string;
  debitAccount?: string;
  creditAccount?: string;
}

export interface CreateEmailSourceInput {
  name: string;
  provider: 'qq_mail' | 'gmail' | 'feishu_mail' | 'microsoft_365' | 'imap';
  mailboxAddress: string;
  mailboxFolder?: string;
  routingRule?: string;
}

export interface SyncEmailSourceInput {
  authorizationCode: string;
  maxMessages?: number;
}

export interface IngestInboundEmailInput {
  sourceId: string;
  externalMessageId: string;
  sender: string;
  subject: string;
  receivedAt: string;
  attachments: Array<{
    fileName: string;
    mimeType?: string;
    sizeBytes?: number;
  }>;
}
