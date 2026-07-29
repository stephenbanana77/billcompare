import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type {
  CollectionStatus,
  CreateEmailSourceInput,
  CreateJobInput,
  CreateRuleInput,
  ImportReceiptsInput,
  IngestInboundEmailInput,
  MailAttachment,
  IssueStatus,
  RuleApprovalStatus,
  ResolveIssueInput,
  SyncEmailSourceInput,
  UpdateVoucherInput,
  VoucherLine,
} from '@shared/reconciliation';
import {
  reconciliationAuditLogs,
  reconciliationComparisons,
  reconciliationCollections,
  reconciliationEmailSources,
  reconciliationInboundEmails,
  reconciliationIssues,
  reconciliationIssueEvents,
  reconciliationJobs,
  reconciliationMappingTemplates,
  reconciliationReceipts,
  reconciliationRules,
  reconciliationVouchers,
} from '@server/database/reconciliation.schema';

type ComparisonSeed = {
  key: string;
  label: string;
  billValue: number;
  expectedValue: number;
  issueType: string;
  suggestedAction: string;
};

const money = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed))
    throw new BadRequestException('金额字段必须是有效数字');
  return Math.round(parsed * 100) / 100;
};

const rate = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed))
    throw new BadRequestException('扣点率必须是有效数字');
  return Math.round(parsed * 10000) / 10000;
};

const requiredText = (value: unknown, label: string): string => {
  const result = String(value ?? '').trim();
  if (!result) throw new BadRequestException(`${label}不能为空`);
  return result;
};

const isoDate = (value = new Date()) => value.toISOString().slice(0, 10);

const maxDate = (values: string[]) =>
  values.filter(Boolean).sort((a, b) => b.localeCompare(a))[0] ?? null;

const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  async getDashboard() {
    const [jobs, issues] = await Promise.all([
      this.db.select().from(reconciliationJobs),
      this.db.select().from(reconciliationIssues),
    ]);
    const openIssues = issues.filter((issue) => issue.status !== 'resolved');
    const matched = jobs.filter((job) => job.status === 'matched').length;
    return {
      totalJobs: jobs.length,
      matchedJobs: matched,
      reviewJobs: jobs.filter((job) => job.status === 'needs_review').length,
      resolvedJobs: jobs.filter((job) => job.status === 'resolved').length,
      openIssues: openIssues.length,
      differenceAmount: openIssues.reduce(
        (sum, issue) => sum + Math.abs(Number(issue.differenceAmount)),
        0,
      ),
      matchRate: jobs.length
        ? Math.round((matched / jobs.length) * 1000) / 10
        : 0,
      recentJobs: [...jobs]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 5),
    };
  }

  listEmailSources() {
    return this.db
      .select()
      .from(reconciliationEmailSources)
      .orderBy(desc(reconciliationEmailSources.updatedAt));
  }

  async createEmailSource(input: CreateEmailSourceInput) {
    const provider = input.provider;
    if (!['qq_mail', 'gmail', 'feishu_mail', 'microsoft_365', 'imap'].includes(provider)) {
      throw new BadRequestException('邮箱来源类型无效');
    }
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(reconciliationEmailSources)
      .values({
        id: randomUUID(),
        name: requiredText(input.name, '邮箱来源名称'),
        provider,
        mailboxAddress: requiredText(input.mailboxAddress, '邮箱地址'),
        mailboxFolder: requiredText(input.mailboxFolder || '账单待处理', '账单文件夹'),
        routingRule: input.routingRule?.trim() || null,
        status: 'awaiting_authorization',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created;
  }

  async listInboundEmails() {
    return this.db
      .select({
        email: reconciliationInboundEmails,
        source: reconciliationEmailSources,
      })
      .from(reconciliationInboundEmails)
      .innerJoin(
        reconciliationEmailSources,
        eq(reconciliationInboundEmails.sourceId, reconciliationEmailSources.id),
      )
      .orderBy(desc(reconciliationInboundEmails.receivedAt));
  }

  async syncEmailSource(id: string, input: SyncEmailSourceInput) {
    const [source] = await this.db
      .select()
      .from(reconciliationEmailSources)
      .where(eq(reconciliationEmailSources.id, id));
    if (!source) throw new NotFoundException('未找到邮件来源');
    if (source.provider !== 'qq_mail') {
      throw new BadRequestException('当前仅 QQ 邮箱已支持现场 IMAP 同步');
    }
    const authorizationCode = requiredText(input.authorizationCode, 'QQ邮箱授权码');
    const maxMessages = Math.max(1, Math.min(Number(input.maxMessages) || 20, 50));
    const client = new ImapFlow({
      host: 'imap.qq.com',
      port: 993,
      secure: true,
      auth: { user: source.mailboxAddress, pass: authorizationCode },
      logger: false,
    });
    let imported = 0;
    let duplicates = 0;
    let stage = '连接 QQ IMAP 服务';
    try {
      await client.connect();
      stage = '读取邮箱文件夹列表';
      const mailboxes = await client.list();
      const folderExists = mailboxes.some((mailbox) => mailbox.path === source.mailboxFolder);
      if (!folderExists) {
        throw new BadRequestException(
          `未找到账单文件夹“${source.mailboxFolder}”。请先在 QQ 邮箱网页端新建同名文件夹，再把测试账单邮件移入该文件夹。`,
        );
      }
      stage = `打开账单文件夹“${source.mailboxFolder}”`;
      const lock = await client.getMailboxLock(source.mailboxFolder);
      try {
        if (!client.mailbox) {
          throw new BadRequestException('未能读取账单文件夹状态');
        }
        const total = client.mailbox.exists;
        const start = Math.max(1, total - maxMessages + 1);
        for await (const message of client.fetch(`${start}:*`, {
          uid: true,
          source: true,
        })) {
          if (!message.source) continue;
          const parsed = await simpleParser(message.source);
          if (!parsed.attachments.length) continue;
          const subject = parsed.subject?.trim() || '无主题邮件';
          const sender = parsed.from?.text?.trim() || source.mailboxAddress;
          const attachments = parsed.attachments.map((attachment) => ({
            fileName: attachment.filename || '未命名附件',
            mimeType: attachment.contentType,
            sizeBytes: attachment.size,
          }));
          if (!this.matchesEmailRoutingRule(source.routingRule, subject, sender, attachments.map((item) => item.fileName))) {
            continue;
          }
          const externalMessageId = parsed.messageId?.trim() || `qq-${source.id}-${message.uid}`;
          const [existing] = await this.db
            .select({ id: reconciliationInboundEmails.id })
            .from(reconciliationInboundEmails)
            .where(
              and(
                eq(reconciliationInboundEmails.sourceId, source.id),
                eq(reconciliationInboundEmails.externalMessageId, externalMessageId),
              ),
            );
          if (existing) {
            duplicates += 1;
            continue;
          }
          await this.ingestInboundEmail({
            sourceId: source.id,
            externalMessageId,
            sender,
            subject,
            receivedAt: (parsed.date || new Date()).toISOString(),
            attachments,
          });
          imported += 1;
        }
      } finally {
        lock.release();
      }
      await client.logout();
      await this.db
        .update(reconciliationEmailSources)
        .set({
          status: 'connected',
          lastSyncedAt: new Date().toISOString(),
          lastError: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(reconciliationEmailSources.id, source.id));
      return { imported, duplicates };
    } catch (error) {
      try {
        await client.logout();
      } catch {
        // The connection may not have completed; no credential is persisted.
      }
      const originalMessage = error instanceof Error ? error.message : '未知错误';
      const message = originalMessage === 'Command failed'
        ? `${stage}失败。若停在连接阶段，请确认填入的是“生成授权码”得到的字符串，而不是 QQ 登录密码；必要时重新生成授权码后再试。`
        : originalMessage;
      this.logger.warn(`QQ IMAP sync failed for source ${source.id}: ${originalMessage}`);
      await this.db
        .update(reconciliationEmailSources)
        .set({
          status: 'error',
          lastError: message.slice(0, 300),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(reconciliationEmailSources.id, source.id));
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(`QQ 邮箱连接失败：${message}`);
    }
  }

  async ingestInboundEmail(input: IngestInboundEmailInput) {
    const [source] = await this.db
      .select()
      .from(reconciliationEmailSources)
      .where(eq(reconciliationEmailSources.id, input.sourceId));
    if (!source) throw new NotFoundException('未找到邮件来源');
    const externalMessageId = requiredText(input.externalMessageId, '邮件唯一标识');
    const [existing] = await this.db
      .select()
      .from(reconciliationInboundEmails)
      .where(
        and(
          eq(reconciliationInboundEmails.sourceId, source.id),
          eq(reconciliationInboundEmails.externalMessageId, externalMessageId),
        ),
      );
    if (existing) return existing;
    const attachments = (input.attachments ?? []).map((attachment) => ({
      fileName: requiredText(attachment.fileName, '附件名称'),
      mimeType: attachment.mimeType?.trim() || undefined,
      sizeBytes: attachment.sizeBytes,
      kind: this.classifyMailAttachment(attachment.fileName),
    })) as MailAttachment[];
    const hasSupportedFile = attachments.some(
      (item) => item.kind !== 'unsupported',
    );
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(reconciliationInboundEmails)
      .values({
        id: randomUUID(),
        sourceId: source.id,
        externalMessageId,
        sender: requiredText(input.sender, '发件人'),
        subject: requiredText(input.subject, '邮件主题'),
        receivedAt: requiredText(input.receivedAt, '收件时间'),
        attachments,
        status: hasSupportedFile ? 'pending_confirmation' : 'ignored',
        rejectionReason: hasSupportedFile ? null : '未检测到可用于对账的 Excel、CSV 或 PDF 附件',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created;
  }

  async updateInboundEmail(
    id: string,
    input: { status: 'accepted' | 'ignored'; rejectionReason?: string },
  ) {
    if (!['accepted', 'ignored'].includes(input.status)) {
      throw new BadRequestException('邮件处理状态无效');
    }
    if (input.status === 'ignored' && !input.rejectionReason?.trim()) {
      throw new BadRequestException('忽略邮件时请填写原因');
    }
    const [updated] = await this.db
      .update(reconciliationInboundEmails)
      .set({
        status: input.status,
        rejectionReason: input.rejectionReason?.trim() || null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(reconciliationInboundEmails.id, id))
      .returning();
    if (!updated) throw new NotFoundException('未找到收件记录');
    return updated;
  }

  listJobs() {
    return this.db
      .select()
      .from(reconciliationJobs)
      .orderBy(desc(reconciliationJobs.createdAt));
  }

  async getJob(id: string) {
    const [job] = await this.db
      .select()
      .from(reconciliationJobs)
      .where(eq(reconciliationJobs.id, id));
    if (!job) throw new NotFoundException('未找到该对账任务');
    const [comparisons, issues, auditLogs] = await Promise.all([
      this.db
        .select()
        .from(reconciliationComparisons)
        .where(eq(reconciliationComparisons.jobId, id))
        .orderBy(asc(reconciliationComparisons.sortOrder)),
      this.db
        .select()
        .from(reconciliationIssues)
        .where(eq(reconciliationIssues.jobId, id))
        .orderBy(desc(reconciliationIssues.createdAt)),
      this.db
        .select()
        .from(reconciliationAuditLogs)
        .where(eq(reconciliationAuditLogs.jobId, id))
        .orderBy(desc(reconciliationAuditLogs.createdAt)),
    ]);
    return { job, comparisons, issues, auditLogs };
  }

  async createJob(input: CreateJobInput) {
    if (input.ruleConfirmed !== true) {
      throw new BadRequestException('请明确确认本次结算规则后再创建任务');
    }
    const mallName = requiredText(input.mallName, '商场名称');
    const storeName = requiredText(input.storeName, '门店名称');
    const storeCode = requiredText(input.storeCode, '门店编码');
    const tolerance = Math.abs(money(input.rule?.toleranceAmount));
    const commissionRate = rate(input.rule?.commissionRate);
    const activityFee = money(input.rule?.activityFee);
    const periodStart = requiredText(input.periodStart, '账期开始日期');
    const periodEnd = requiredText(input.periodEnd, '账期结束日期');
    if (periodStart > periodEnd) {
      throw new BadRequestException('账期开始日期不能晚于结束日期');
    }
    if (input.ruleId) {
      const [selectedRule] = await this.db
        .select()
        .from(reconciliationRules)
        .where(eq(reconciliationRules.id, input.ruleId));
      if (!selectedRule) throw new BadRequestException('所选合同规则不存在');
      if (!this.ruleAppliesToJob(selectedRule, {
        mallName,
        storeCode,
        billType: input.billType,
        periodStart,
        periodEnd,
      })) {
        throw new BadRequestException('所选合同规则不适用于当前商场、门店或账期，请重新匹配');
      }
      if (
        rate(selectedRule.commissionRate) !== commissionRate ||
        money(selectedRule.activityFee) !== activityFee ||
        money(selectedRule.toleranceAmount) !== tolerance
      ) {
        throw new BadRequestException('合同规则已更新，请重新打开导入页面后再计算');
      }
    }
    const audit = input.importAudit;
    if (!audit?.dateFilterApplied || !audit.erpDateColumn) {
      throw new BadRequestException('ERP 数据必须映射日期列并按账期过滤');
    }
    if (
      audit.erpRowsIncluded < 1 ||
      audit.erpRowsIncluded > audit.erpRowsTotal
    ) {
      throw new BadRequestException(
        'ERP 账期内数据行数无效，请检查日期列和账期',
      );
    }
    if (
      audit.billPeriodStart !== periodStart ||
      audit.billPeriodEnd !== periodEnd
    ) {
      throw new BadRequestException('任务账期与商场账单账期不一致');
    }
    const mappingTemplate = input.mappingTemplate;
    if (
      !mappingTemplate?.billSignature ||
      !mappingTemplate.erpSignature ||
      !mappingTemplate.billMapping ||
      !mappingTemplate.erpMapping
    ) {
      throw new BadRequestException('字段映射模板信息不完整');
    }

    const billSales = money(input.bill?.salesAmount);
    const billRefund = money(input.bill?.refundAmount);
    const billCommission = money(input.bill?.commissionAmount);
    const billActivity = money(input.bill?.activityFee);
    const billSettlement = money(input.bill?.settlementAmount);
    const erpSales = money(input.erp?.salesAmount);
    const erpRefund = money(input.erp?.refundAmount);
    const expectedCommission = money(
      ((erpSales - erpRefund) * commissionRate) / 100,
    );
    const expectedSettlement = money(
      erpSales - erpRefund - expectedCommission - activityFee,
    );

    const comparisons: ComparisonSeed[] = [
      {
        key: 'sales_amount',
        label: '销售额',
        billValue: billSales,
        expectedValue: erpSales,
        issueType: 'sales_difference',
        suggestedAction:
          '核对商场销售汇总与 ERP 日结数据，确认是否存在跨期或漏单。',
      },
      {
        key: 'refund_amount',
        label: '退款金额',
        billValue: billRefund,
        expectedValue: erpRefund,
        issueType: 'refund_difference',
        suggestedAction:
          '检查退款发生日与商场入账日，确认是否属于账期切分差异。',
      },
      {
        key: 'commission_amount',
        label: '扣点金额',
        billValue: billCommission,
        expectedValue: expectedCommission,
        issueType: 'commission_difference',
        suggestedAction:
          '复核扣点比例及计提基数，必要时依据合同向商场发起申诉。',
      },
      {
        key: 'activity_fee',
        label: '活动费',
        billValue: billActivity,
        expectedValue: activityFee,
        issueType: 'activity_fee_difference',
        suggestedAction: '核对活动费审批或费用约定，确认是否存在未备案费用。',
      },
      {
        key: 'settlement_amount',
        label: '实结金额',
        billValue: billSettlement,
        expectedValue: expectedSettlement,
        issueType: 'settlement_difference',
        suggestedAction:
          '基于销售、退款、扣点和活动费的分项差异确认最终应结金额。',
      },
    ];

    const differences = comparisons.map((item) =>
      money(item.billValue - item.expectedValue),
    );
    const differenceIssues = comparisons.filter(
      (_, index) => Math.abs(differences[index]) > tolerance,
    );
    const warningIssues = (input.mappingWarnings ?? []).filter(Boolean);
    const issueCount = differenceIssues.length + warningIssues.length;
    const now = new Date();
    const jobId = randomUUID();
    const taskNo = `REC-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${jobId.slice(0, 6).toUpperCase()}`;

    await this.db.transaction(async (tx) => {
      let mappingTemplateId = mappingTemplate.templateId || null;
      const templateNow = new Date().toISOString();
      if (mappingTemplateId) {
        const [existingTemplate] = await tx
          .select()
          .from(reconciliationMappingTemplates)
          .where(eq(reconciliationMappingTemplates.id, mappingTemplateId));
        if (!existingTemplate) {
          throw new BadRequestException('已选择的字段映射模板不存在');
        }
        await tx
          .update(reconciliationMappingTemplates)
          .set({
            ...(mappingTemplate.save
              ? {
                  name: requiredText(mappingTemplate.name, '映射模板名称'),
                  billType: input.billType,
                  billHeaders: mappingTemplate.billHeaders,
                  erpHeaders: mappingTemplate.erpHeaders,
                  billMapping: mappingTemplate.billMapping,
                  erpMapping: mappingTemplate.erpMapping,
                  billSignature: mappingTemplate.billSignature,
                  erpSignature: mappingTemplate.erpSignature,
                  updatedAt: templateNow,
                }
              : {}),
            useCount: sql`${reconciliationMappingTemplates.useCount} + 1`,
            lastUsedAt: templateNow,
          })
          .where(eq(reconciliationMappingTemplates.id, mappingTemplateId));
      } else if (mappingTemplate.save) {
        const [existingTemplate] = await tx
          .select()
          .from(reconciliationMappingTemplates)
          .where(
            and(
              eq(reconciliationMappingTemplates.mallName, mallName),
              eq(
                reconciliationMappingTemplates.billSignature,
                mappingTemplate.billSignature,
              ),
              eq(
                reconciliationMappingTemplates.erpSignature,
                mappingTemplate.erpSignature,
              ),
            ),
          );
        if (existingTemplate) {
          mappingTemplateId = existingTemplate.id;
          await tx
            .update(reconciliationMappingTemplates)
            .set({
              name: requiredText(mappingTemplate.name, '映射模板名称'),
              billType: input.billType,
              billHeaders: mappingTemplate.billHeaders,
              erpHeaders: mappingTemplate.erpHeaders,
              billMapping: mappingTemplate.billMapping,
              erpMapping: mappingTemplate.erpMapping,
              useCount: sql`${reconciliationMappingTemplates.useCount} + 1`,
              lastUsedAt: templateNow,
              updatedAt: templateNow,
            })
            .where(eq(reconciliationMappingTemplates.id, existingTemplate.id));
        } else {
          mappingTemplateId = randomUUID();
          await tx.insert(reconciliationMappingTemplates).values({
            id: mappingTemplateId,
            name: requiredText(mappingTemplate.name, '映射模板名称'),
            mallName,
            billType: input.billType,
            billSignature: mappingTemplate.billSignature,
            erpSignature: mappingTemplate.erpSignature,
            billHeaders: mappingTemplate.billHeaders,
            erpHeaders: mappingTemplate.erpHeaders,
            billMapping: mappingTemplate.billMapping,
            erpMapping: mappingTemplate.erpMapping,
            useCount: 1,
            lastUsedAt: templateNow,
          });
        }
      }

      await tx.insert(reconciliationJobs).values({
        id: jobId,
        taskNo,
        mallName,
        storeName,
        storeCode,
        periodStart,
        periodEnd,
        status: issueCount ? 'needs_review' : 'matched',
        billType: requiredText(input.billType, '账单类型'),
        sourceBillName: requiredText(input.sourceBillName, '商场账单文件名'),
        sourceErpName: requiredText(input.sourceErpName, 'ERP 文件名'),
        ruleId: input.ruleId || null,
        ruleSnapshot: {
          name: requiredText(input.rule?.name, '规则名称'),
          commissionRate,
          activityFee,
          toleranceAmount: tolerance,
          periodType: requiredText(input.rule?.periodType, '账期类型'),
        },
        billSnapshot: {
          salesAmount: billSales,
          refundAmount: billRefund,
          commissionAmount: billCommission,
          activityFee: billActivity,
          settlementAmount: billSettlement,
          periodStart: audit.billPeriodStart,
          periodEnd: audit.billPeriodEnd,
        },
        erpSnapshot: {
          salesAmount: erpSales,
          refundAmount: erpRefund,
          rowCount: audit.erpRowsTotal,
          includedRowCount: audit.erpRowsIncluded,
          dateColumn: audit.erpDateColumn,
          periodStart,
          periodEnd,
        },
        salesDiff: String(differences[0]),
        refundDiff: String(differences[1]),
        settlementDiff: String(differences[4]),
        issueCount,
      });

      await tx.insert(reconciliationCollections).values({
        id: randomUUID(),
        jobId,
        expectedAmount: String(billSettlement),
        receivedAmount: '0',
        differenceAmount: String(money(0 - billSettlement)),
        status: 'pending',
      });

      await tx.insert(reconciliationComparisons).values(
        comparisons.map((item, index) => ({
          id: randomUUID(),
          jobId,
          fieldKey: item.key,
          fieldLabel: item.label,
          billValue: String(item.billValue),
          erpValue: String(item.expectedValue),
          difference: String(differences[index]),
          result:
            Math.abs(differences[index]) <= tolerance
              ? 'matched'
              : 'difference',
          evidence: {
            billFile: input.sourceBillName,
            erpFile: input.sourceErpName,
            rule: input.rule.name,
            periodStart,
            periodEnd,
            erpRowsIncluded: audit.erpRowsIncluded,
            erpRowsTotal: audit.erpRowsTotal,
          },
          sortOrder: index + 1,
        })),
      );

      if (differenceIssues.length) {
        await tx.insert(reconciliationIssues).values(
          differenceIssues.map((item) => {
            const index = comparisons.indexOf(item);
            const difference = differences[index];
            return {
              id: randomUUID(),
              jobId,
              type: item.issueType,
              severity: Math.abs(difference) >= 1000 ? 'high' : 'medium',
              title: `${item.label}差异 ${difference > 0 ? '多计' : '少计'} ¥${Math.abs(difference).toFixed(2)}`,
              description: `商场账单为 ¥${item.billValue.toFixed(2)}，系统依据 ERP 与规则计算为 ¥${item.expectedValue.toFixed(2)}。`,
              differenceAmount: String(difference),
              status: 'open',
              suggestedAction: item.suggestedAction,
              dueDate: addDays(isoDate(), Math.abs(difference) >= 1000 ? 2 : 3),
            };
          }),
        );
      }

      if (warningIssues.length) {
        await tx.insert(reconciliationIssues).values(
          warningIssues.map((warning) => ({
            id: randomUUID(),
            jobId,
            type: 'mapping_warning',
            severity: 'medium',
            title: '字段映射需人工确认',
            description: warning,
            differenceAmount: '0',
            status: 'open',
            suggestedAction: '返回原始文件确认字段含义，修正映射后重新导入。',
            dueDate: addDays(isoDate(), 3),
          })),
        );
      }

      await tx.insert(reconciliationAuditLogs).values({
        id: randomUUID(),
        jobId,
        action: 'job_created',
        detail: {
          taskNo,
          issueCount,
          sourceBillName: input.sourceBillName,
          sourceErpName: input.sourceErpName,
          periodStart,
          periodEnd,
          erpDateColumn: audit.erpDateColumn,
          erpRowsIncluded: audit.erpRowsIncluded,
          erpRowsTotal: audit.erpRowsTotal,
          mappingTemplateId,
          mappingTemplateSaved: mappingTemplate.save,
        },
        operatorName: '当前用户',
      });
    });

    return this.getJob(jobId);
  }

  async deleteJob(id: string) {
    const deleted = await this.db
      .delete(reconciliationJobs)
      .where(eq(reconciliationJobs.id, id))
      .returning({ id: reconciliationJobs.id });
    if (!deleted.length) throw new NotFoundException('未找到该对账任务');
    return { deleted: true };
  }

  async listIssues() {
    const rows = await this.db
      .select({
        issue: reconciliationIssues,
        job: {
          id: reconciliationJobs.id,
          taskNo: reconciliationJobs.taskNo,
          mallName: reconciliationJobs.mallName,
          storeName: reconciliationJobs.storeName,
          periodStart: reconciliationJobs.periodStart,
          periodEnd: reconciliationJobs.periodEnd,
        },
      })
      .from(reconciliationIssues)
      .innerJoin(
        reconciliationJobs,
        eq(reconciliationIssues.jobId, reconciliationJobs.id),
      )
      .orderBy(desc(reconciliationIssues.createdAt));
    return rows;
  }

  async updateIssue(id: string, input: ResolveIssueInput) {
    const status = input.status as IssueStatus;
    if (!['open', 'in_progress', 'pending_approval', 'resolved', 'rejected'].includes(status)) {
      throw new BadRequestException('异常状态无效');
    }
    const [current] = await this.db
      .select()
      .from(reconciliationIssues)
      .where(eq(reconciliationIssues.id, id));
    if (!current) throw new NotFoundException('未找到该异常');

    const note = input.resolutionNote?.trim() || null;
    const evidence = input.resolutionEvidence?.trim() || null;
    const reviewerName = input.reviewerName?.trim() || null;
    const reviewNote = input.reviewNote?.trim() || null;
    if (status === 'pending_approval' && !note) {
      throw new BadRequestException('提交复核前请填写处理结论');
    }
    if (status === 'resolved' && current.status !== 'pending_approval') {
      throw new BadRequestException('异常需先提交复核，审批通过后才能关闭');
    }
    if (['resolved', 'rejected'].includes(status) && !reviewerName) {
      throw new BadRequestException('请填写复核人');
    }
    if (status === 'rejected' && !reviewNote) {
      throw new BadRequestException('打回时请说明原因');
    }
    const action =
      status === 'pending_approval'
        ? 'issue_submitted_for_approval'
        : status === 'resolved'
          ? 'issue_approved_and_closed'
          : status === 'rejected'
            ? 'issue_rejected'
            : status === 'in_progress'
              ? 'issue_assigned_or_started'
              : 'issue_reopened';
    const [updated] = await this.db
      .update(reconciliationIssues)
      .set({
        status,
        resolutionNote: note,
        resolutionEvidence: evidence,
        assignedTo: input.assignedTo?.trim() || null,
        dueDate: input.dueDate?.trim() || current.dueDate,
        reviewerName,
        reviewNote,
        reviewedAt: ['resolved', 'rejected'].includes(status)
          ? new Date().toISOString()
          : current.reviewedAt,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(reconciliationIssues.id, id))
      .returning();

    const openIssues = await this.db
      .select({ id: reconciliationIssues.id })
      .from(reconciliationIssues)
      .where(
        and(
          eq(reconciliationIssues.jobId, updated.jobId),
          ne(reconciliationIssues.status, 'resolved'),
        ),
      );
    const jobStatus = openIssues.length ? 'needs_review' : 'resolved';
    await this.db
      .update(reconciliationJobs)
      .set({ status: jobStatus, updatedAt: new Date().toISOString() })
      .where(eq(reconciliationJobs.id, updated.jobId));
    await this.db.insert(reconciliationAuditLogs).values({
      id: randomUUID(),
      jobId: updated.jobId,
      action,
      detail: {
        issueId: id,
        status,
        resolutionNote: note ?? '',
        resolutionEvidence: evidence ?? '',
        reviewNote: reviewNote ?? '',
      },
      operatorName: reviewerName || input.assignedTo?.trim() || '当前用户',
    });
    await this.db.insert(reconciliationIssueEvents).values({
      id: randomUUID(),
      issueId: id,
      action,
      fromStatus: current.status,
      toStatus: status,
      comment: reviewNote || note,
      operatorName: reviewerName || input.assignedTo?.trim() || '当前用户',
    });
    return updated;
  }

  async listIssueEvents(issueId: string) {
    return this.db
      .select()
      .from(reconciliationIssueEvents)
      .where(eq(reconciliationIssueEvents.issueId, issueId))
      .orderBy(desc(reconciliationIssueEvents.createdAt));
  }

  listRules() {
    return this.db
      .select()
      .from(reconciliationRules)
      .orderBy(desc(reconciliationRules.updatedAt));
  }

  async createRule(input: CreateRuleInput) {
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(reconciliationRules)
      .values({
        id: randomUUID(),
        ...this.normalizeRule(input),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created;
  }

  async updateRule(id: string, input: CreateRuleInput) {
    const [updated] = await this.db
      .update(reconciliationRules)
      .set({
        ...this.normalizeRule(input),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(reconciliationRules.id, id))
      .returning();
    if (!updated) throw new NotFoundException('未找到该规则');
    return updated;
  }

  async deleteRule(id: string) {
    const deleted = await this.db
      .delete(reconciliationRules)
      .where(eq(reconciliationRules.id, id))
      .returning({ id: reconciliationRules.id });
    if (!deleted.length) throw new NotFoundException('未找到该规则');
    return { deleted: true };
  }

  listMappingTemplates() {
    return this.db
      .select()
      .from(reconciliationMappingTemplates)
      .orderBy(desc(reconciliationMappingTemplates.updatedAt));
  }

  async deleteMappingTemplate(id: string) {
    const deleted = await this.db
      .delete(reconciliationMappingTemplates)
      .where(eq(reconciliationMappingTemplates.id, id))
      .returning({ id: reconciliationMappingTemplates.id });
    if (!deleted.length) throw new NotFoundException('未找到该字段映射模板');
    return { deleted: true };
  }

  async listCollections() {
    await this.syncMissingCollections();
    const [collectionRows, receipts, vouchers] = await Promise.all([
      this.db
        .select({
          collection: reconciliationCollections,
          job: reconciliationJobs,
        })
        .from(reconciliationCollections)
        .innerJoin(
          reconciliationJobs,
          eq(reconciliationCollections.jobId, reconciliationJobs.id),
        )
        .orderBy(desc(reconciliationCollections.updatedAt)),
      this.db
        .select()
        .from(reconciliationReceipts)
        .orderBy(desc(reconciliationReceipts.paymentDate)),
      this.db.select().from(reconciliationVouchers),
    ]);

    return collectionRows.map((row) => ({
      ...row,
      receipts: receipts.filter(
        (receipt) => receipt.collectionId === row.collection.id,
      ),
      voucher:
        vouchers.find((voucher) => voucher.collectionId === row.collection.id) ??
        null,
      voucherBlocked:
        row.collection.status === 'matched' && row.job.status === 'needs_review',
    }));
  }

  async importReceipts(jobId: string, input: ImportReceiptsInput) {
    const [job] = await this.db
      .select()
      .from(reconciliationJobs)
      .where(eq(reconciliationJobs.id, jobId));
    if (!job) throw new NotFoundException('未找到该对账任务');

    const collection = await this.ensureCollection(job);
    const receipts = input.receipts ?? [];
    if (!receipts.length) {
      throw new BadRequestException('请至少导入一条回款流水');
    }
    const dueDate = input.dueDate?.trim() || collection.dueDate || null;
    const sourceFileName = requiredText(input.sourceFileName, '流水文件名');
    const preparedReceipts = receipts.map((receipt, index) => ({
      id: randomUUID(),
      collectionId: collection.id,
      sourceFileName,
      bankReference: requiredText(
        receipt.bankReference || `${sourceFileName}#ROW-${index + 1}`,
        '银行流水号',
      ),
      payerName: requiredText(receipt.payerName, '付款方'),
      paymentDate: requiredText(receipt.paymentDate, '到账日期'),
      amount: String(money(receipt.amount)),
      note: receipt.note?.trim() || null,
    }));

    const existingReceipts = await this.db
      .select()
      .from(reconciliationReceipts)
      .where(eq(reconciliationReceipts.collectionId, collection.id));
    const existingReferences = new Set(
      existingReceipts.map((receipt) => receipt.bankReference),
    );
    const freshReceipts = preparedReceipts.filter(
      (receipt) => !existingReferences.has(receipt.bankReference),
    );
    const skippedDuplicates = preparedReceipts.length - freshReceipts.length;
    if (!freshReceipts.length) {
      throw new BadRequestException(
        '本次导入的流水与已有回款记录重复，未新增任何数据',
      );
    }
    const receivedAmount = money(
      existingReceipts.reduce((sum, receipt) => sum + Number(receipt.amount), 0) +
        freshReceipts.reduce((sum, receipt) => sum + Number(receipt.amount), 0),
    );
    const expectedAmount = money(collection.expectedAmount);
    const tolerance = Math.abs(money(job.ruleSnapshot.toleranceAmount));
    const status = this.resolveCollectionStatus(
      expectedAmount,
      receivedAmount,
      dueDate,
      tolerance,
    );
    const lastReceiptAt = maxDate([
      ...existingReceipts.map((receipt) => receipt.paymentDate),
      ...freshReceipts.map((receipt) => receipt.paymentDate),
    ]);

    await this.db.transaction(async (tx) => {
      await tx
        .insert(reconciliationReceipts)
        .values(freshReceipts)
        .onConflictDoNothing();
      await tx
        .update(reconciliationCollections)
        .set({
          dueDate,
          receivedAmount: String(receivedAmount),
          differenceAmount: String(money(receivedAmount - expectedAmount)),
          status,
          lastReceiptAt,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(reconciliationCollections.id, collection.id));
      await tx.insert(reconciliationAuditLogs).values({
        id: randomUUID(),
        jobId,
        action: 'receipt_imported',
        detail: {
          collectionId: collection.id,
          sourceFileName,
          importedRows: freshReceipts.length,
          skippedDuplicates,
          receivedAmount,
          expectedAmount,
          status,
          dueDate,
        },
        operatorName: '当前用户',
      });
    });

    const [updatedCollection] = await this.db
      .select()
      .from(reconciliationCollections)
      .where(eq(reconciliationCollections.id, collection.id));
    await this.createVoucherDraftIfEligible(job, updatedCollection);
    return this.getCollectionByJob(jobId);
  }

  async listVouchers() {
    return this.db
      .select({
        voucher: reconciliationVouchers,
        job: reconciliationJobs,
        collection: reconciliationCollections,
      })
      .from(reconciliationVouchers)
      .innerJoin(
        reconciliationJobs,
        eq(reconciliationVouchers.jobId, reconciliationJobs.id),
      )
      .innerJoin(
        reconciliationCollections,
        eq(reconciliationVouchers.collectionId, reconciliationCollections.id),
      )
      .orderBy(desc(reconciliationVouchers.updatedAt));
  }

  async updateVoucher(id: string, input: UpdateVoucherInput) {
    const [voucher] = await this.db
      .select()
      .from(reconciliationVouchers)
      .where(eq(reconciliationVouchers.id, id));
    if (!voucher) throw new NotFoundException('未找到该记账草稿');
    if (input.status && !['draft', 'confirmed'].includes(input.status)) {
      throw new BadRequestException('凭证状态无效');
    }
    const summary = input.summary?.trim() || voucher.summary;
    const debitAccount = input.debitAccount?.trim() || voucher.debitAccount;
    const creditAccount = input.creditAccount?.trim() || voucher.creditAccount;
    const totalAmount = money(voucher.totalAmount);
    const lines = this.buildVoucherLines({
      amount: totalAmount,
      summary,
      debitAccount,
      creditAccount,
    });
    const confirming = input.status === 'confirmed' && voucher.status !== 'confirmed';

    const [updated] = await this.db
      .update(reconciliationVouchers)
      .set({
        status: input.status ?? voucher.status,
        summary,
        debitAccount,
        creditAccount,
        lines,
        confirmedBy: confirming ? '当前用户' : voucher.confirmedBy,
        confirmedAt: confirming ? new Date().toISOString() : voucher.confirmedAt,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(reconciliationVouchers.id, id))
      .returning();

    await this.db.insert(reconciliationAuditLogs).values({
      id: randomUUID(),
      jobId: voucher.jobId,
      action: confirming ? 'voucher_confirmed' : 'voucher_updated',
      detail: {
        voucherId: id,
        voucherNo: voucher.voucherNo,
        status: updated.status,
      },
      operatorName: '当前用户',
    });
    return updated;
  }

  private async getCollectionByJob(jobId: string) {
    await this.syncMissingCollections();
    const rows = await this.listCollections();
    const row = rows.find((item) => item.job.id === jobId);
    if (!row) throw new NotFoundException('未找到该回款计划');
    return row;
  }

  private async syncMissingCollections() {
    const [jobs, collections] = await Promise.all([
      this.db.select().from(reconciliationJobs),
      this.db.select().from(reconciliationCollections),
    ]);
    const existingJobIds = new Set(collections.map((item) => item.jobId));
    const missing = jobs.filter((job) => !existingJobIds.has(job.id));
    if (!missing.length) return;
    await this.db.insert(reconciliationCollections).values(
      missing.map((job) => {
        const expectedAmount = money(job.billSnapshot.settlementAmount);
        return {
          id: randomUUID(),
          jobId: job.id,
          expectedAmount: String(expectedAmount),
          receivedAmount: '0',
          differenceAmount: String(money(0 - expectedAmount)),
          status: 'pending',
        };
      }),
    );
  }

  private async ensureCollection(job: typeof reconciliationJobs.$inferSelect) {
    const [collection] = await this.db
      .select()
      .from(reconciliationCollections)
      .where(eq(reconciliationCollections.jobId, job.id));
    if (collection) return collection;
    const expectedAmount = money(job.billSnapshot.settlementAmount);
    const [created] = await this.db
      .insert(reconciliationCollections)
      .values({
        id: randomUUID(),
        jobId: job.id,
        expectedAmount: String(expectedAmount),
        receivedAmount: '0',
        differenceAmount: String(money(0 - expectedAmount)),
        status: 'pending',
      })
      .returning();
    return created;
  }

  private resolveCollectionStatus(
    expectedAmount: number,
    receivedAmount: number,
    dueDate: string | null,
    tolerance: number,
  ): CollectionStatus {
    if (
      receivedAmount > 0 &&
      Math.abs(receivedAmount - expectedAmount) <= tolerance
    )
      return 'matched';
    if (receivedAmount > expectedAmount + tolerance) return 'overpaid';
    if (dueDate && dueDate < isoDate()) return 'overdue';
    if (receivedAmount <= 0) return 'pending';
    return 'partial';
  }

  private async createVoucherDraftIfEligible(
    job: typeof reconciliationJobs.$inferSelect,
    collection: typeof reconciliationCollections.$inferSelect,
  ) {
    if (collection.status !== 'matched') return;
    if (job.status === 'needs_review') return;
    const [existingVoucher] = await this.db
      .select()
      .from(reconciliationVouchers)
      .where(eq(reconciliationVouchers.collectionId, collection.id));
    if (existingVoucher) return;
    const openIssues = await this.db
      .select({ id: reconciliationIssues.id })
      .from(reconciliationIssues)
      .where(
        and(
          eq(reconciliationIssues.jobId, job.id),
          ne(reconciliationIssues.status, 'resolved'),
        ),
      );
    if (openIssues.length) return;

    const amount = money(collection.receivedAmount);
    const voucherDate = collection.lastReceiptAt || isoDate();
    const summary = `${job.mallName} ${job.periodStart}至${job.periodEnd} 商场结算回款`;
    const voucherNo = `VCH-${voucherDate.replaceAll('-', '')}-${job.id
      .slice(0, 6)
      .toUpperCase()}`;
    const lines = this.buildVoucherLines({
      amount,
      summary,
      debitAccount: '银行存款',
      creditAccount: '应收账款-商场',
    });

    await this.db.insert(reconciliationVouchers).values({
      id: randomUUID(),
      jobId: job.id,
      collectionId: collection.id,
      voucherNo,
      status: 'draft',
      voucherDate,
      summary,
      totalAmount: String(amount),
      debitAccount: '银行存款',
      creditAccount: '应收账款-商场',
      lines,
    });
    await this.db.insert(reconciliationAuditLogs).values({
      id: randomUUID(),
      jobId: job.id,
      action: 'voucher_draft_created',
      detail: {
        collectionId: collection.id,
        voucherNo,
        amount,
      },
      operatorName: '系统',
    });
  }

  private buildVoucherLines(input: {
    amount: number;
    summary: string;
    debitAccount: string;
    creditAccount: string;
  }): VoucherLine[] {
    return [
      {
        direction: 'debit',
        account: input.debitAccount,
        amount: input.amount,
        summary: input.summary,
      },
      {
        direction: 'credit',
        account: input.creditAccount,
        amount: input.amount,
        summary: input.summary,
      },
    ];
  }

  private normalizeRule(input: CreateRuleInput) {
    const effectiveStart = input.effectiveStart?.trim() || null;
    const effectiveEnd = input.effectiveEnd?.trim() || null;
    if (effectiveStart && effectiveEnd && effectiveStart > effectiveEnd) {
      throw new BadRequestException('合同生效开始日不能晚于结束日');
    }
    const approvalStatus = (input.approvalStatus ?? 'approved') as RuleApprovalStatus;
    if (!['draft', 'pending_approval', 'approved', 'disabled'].includes(approvalStatus)) {
      throw new BadRequestException('合同审批状态无效');
    }
    return {
      name: requiredText(input.name, '规则名称'),
      mallName: input.mallName?.trim() || null,
      storeCode: input.storeCode?.trim() || null,
      contractNo: input.contractNo?.trim() || null,
      contractVersion: input.contractVersion?.trim() || null,
      effectiveStart,
      effectiveEnd,
      billType: requiredText(input.billType, '账单类型'),
      periodType: requiredText(input.periodType, '账期类型'),
      commissionRate: String(rate(input.commissionRate)),
      activityFee: String(money(input.activityFee)),
      toleranceAmount: String(Math.abs(money(input.toleranceAmount))),
      enabled: (input.enabled ?? true) && approvalStatus === 'approved',
      approvalStatus,
      notes: input.notes?.trim() || null,
    };
  }

  private ruleAppliesToJob(
    rule: typeof reconciliationRules.$inferSelect,
    input: {
      mallName: string;
      storeCode: string;
      billType: string;
      periodStart: string;
      periodEnd: string;
    },
  ) {
    const normalized = (value: string | null | undefined) =>
      String(value ?? '').trim().toLowerCase().replace(/\s/g, '');
    const mallMatches =
      !rule.mallName || normalized(rule.mallName) === normalized(input.mallName);
    const storeMatches =
      !rule.storeCode || normalized(rule.storeCode) === normalized(input.storeCode);
    const periodMatches =
      (!rule.effectiveStart || rule.effectiveStart <= input.periodStart) &&
      (!rule.effectiveEnd || rule.effectiveEnd >= input.periodEnd);
    return (
      rule.enabled &&
      rule.approvalStatus === 'approved' &&
      rule.billType === input.billType &&
      mallMatches &&
      storeMatches &&
      periodMatches
    );
  }

  private classifyMailAttachment(fileName: string): MailAttachment['kind'] {
    const normalized = fileName.trim().toLowerCase();
    if (normalized.endsWith('.pdf')) return 'supported_pdf';
    if (normalized.endsWith('.xlsx') || normalized.endsWith('.xls') || normalized.endsWith('.csv')) {
      return /erp|pos|销售|交易|营业/.test(normalized)
        ? 'erp_export'
        : 'settlement_bill';
    }
    return 'unsupported';
  }

  private matchesEmailRoutingRule(
    rule: string | null,
    subject: string,
    sender: string,
    attachmentNames: string[],
  ) {
    const tokens = String(rule ?? '')
      .split(/[，,\n]/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    if (!tokens.length) return true;
    const haystack = `${subject} ${sender} ${attachmentNames.join(' ')}`.toLowerCase();
    return tokens.some((token) => haystack.includes(token));
  }
}
