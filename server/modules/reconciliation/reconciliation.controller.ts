import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  BadRequestException,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type {
  CreateJobInput,
  CreateEmailSourceInput,
  CreateRuleInput,
  IngestInboundEmailInput,
  ImportReceiptsInput,
  ResolveIssueInput,
  SyncEmailSourceInput,
  UpdateVoucherInput,
  VisionRefinementCandidate,
} from '@shared/reconciliation';
import { ReconciliationService } from './reconciliation.service';
import { VisionExtractionService } from './vision-extraction.service';
import { PaddleOcrService } from './ocr/paddle-ocr.service';

type UploadedImagePage = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
};

@Controller('api/reconciliation')
export class ReconciliationController {
  constructor(
    private readonly service: ReconciliationService,
    private readonly visionExtractionService: VisionExtractionService,
    private readonly paddleOcrService: PaddleOcrService,
  ) {}

  @Post('ocr-extractions')
  @UseInterceptors(
    FilesInterceptor('pages', 2, {
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  async extractOcrBill(@UploadedFiles() pages: UploadedImagePage[]) {
    if (!pages?.length) throw new BadRequestException('请上传需要OCR识别的页面图片。');
    if (pages.some((page) => !/^image\/(png|jpeg|webp)$/.test(page.mimetype))) {
      throw new BadRequestException('OCR仅接受PNG、JPEG或WebP页面图片。');
    }
    return this.paddleOcrService.extractFromImages(pages.map((page) => page.buffer));
  }

  @Post('vision-extractions')
  @UseInterceptors(
    FilesInterceptor('pages', 2, {
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  async extractVisionBill(
    @UploadedFiles() pages: UploadedImagePage[],
    @Body('fileName') fileName?: string,
  ) {
    if (!pages?.length) {
      throw new BadRequestException('请上传待识别结算单的页面图片。');
    }
    if (pages.some((page) => !/^image\/(png|jpeg|webp)$/.test(page.mimetype))) {
      throw new BadRequestException('视觉识别仅接受 PNG、JPEG 或 WebP 页面图片。');
    }
    return this.visionExtractionService.extractFromImages(
      fileName?.trim() || pages[0].originalname,
      pages.map((page) => page.buffer),
    );
  }

  @Post('vision-refinements')
  @UseInterceptors(
    FilesInterceptor('tiles', 12, {
      limits: { fileSize: 8 * 1024 * 1024 },
    }),
  )
  async refineVisionBill(
    @UploadedFiles() tiles: UploadedImagePage[],
    @Body('candidates') candidateJson?: string,
  ) {
    if (!tiles?.length) throw new BadRequestException('请上传用于二次复核的高清局部图片。');
    if (tiles.some((tile) => !/^image\/(png|jpeg|webp)$/.test(tile.mimetype))) {
      throw new BadRequestException('二次复核仅接受 PNG、JPEG 或 WebP 图片。');
    }
    let candidates: VisionRefinementCandidate[];
    try {
      candidates = JSON.parse(candidateJson || '[]') as VisionRefinementCandidate[];
    } catch {
      throw new BadRequestException('二次复核字段格式无效。');
    }
    if (!Array.isArray(candidates) || !candidates.length) {
      throw new BadRequestException('没有需要二次复核的低置信字段。');
    }
    return this.visionExtractionService.refineLowConfidenceFields(
      tiles.map((tile) => tile.buffer),
      candidates,
    );
  }

  @Get('dashboard')
  getDashboard() {
    return this.service.getDashboard();
  }

  @Get('email-sources')
  listEmailSources() {
    return this.service.listEmailSources();
  }

  @Post('email-sources')
  createEmailSource(@Body() input: CreateEmailSourceInput) {
    return this.service.createEmailSource(input);
  }

  @Post('email-sources/:id/sync')
  syncEmailSource(
    @Param('id') id: string,
    @Body() input: SyncEmailSourceInput,
  ) {
    return this.service.syncEmailSource(id, input);
  }

  @Get('inbound-emails')
  listInboundEmails() {
    return this.service.listInboundEmails();
  }

  @Post('inbound-emails')
  ingestInboundEmail(@Body() input: IngestInboundEmailInput) {
    return this.service.ingestInboundEmail(input);
  }

  @Patch('inbound-emails/:id')
  updateInboundEmail(
    @Param('id') id: string,
    @Body() input: { status: 'accepted' | 'ignored'; rejectionReason?: string },
  ) {
    return this.service.updateInboundEmail(id, input);
  }

  @Get('jobs')
  listJobs() {
    return this.service.listJobs();
  }

  @Get('jobs/:id')
  getJob(@Param('id') id: string) {
    return this.service.getJob(id);
  }

  @Post('jobs')
  createJob(@Body() input: CreateJobInput) {
    return this.service.createJob(input);
  }

  @Delete('jobs/:id')
  deleteJob(@Param('id') id: string) {
    return this.service.deleteJob(id);
  }

  @Post('jobs/:id/receipts')
  importReceipts(
    @Param('id') id: string,
    @Body() input: ImportReceiptsInput,
  ) {
    return this.service.importReceipts(id, input);
  }

  @Get('collections')
  listCollections() {
    return this.service.listCollections();
  }

  @Get('vouchers')
  listVouchers() {
    return this.service.listVouchers();
  }

  @Patch('vouchers/:id')
  updateVoucher(@Param('id') id: string, @Body() input: UpdateVoucherInput) {
    return this.service.updateVoucher(id, input);
  }

  @Get('issues')
  listIssues() {
    return this.service.listIssues();
  }

  @Patch('issues/:id')
  resolveIssue(@Param('id') id: string, @Body() input: ResolveIssueInput) {
    return this.service.updateIssue(id, input);
  }

  @Get('issues/:id/events')
  listIssueEvents(@Param('id') id: string) {
    return this.service.listIssueEvents(id);
  }

  @Get('rules')
  listRules() {
    return this.service.listRules();
  }

  @Post('rules')
  createRule(@Body() input: CreateRuleInput) {
    return this.service.createRule(input);
  }

  @Put('rules/:id')
  updateRule(@Param('id') id: string, @Body() input: CreateRuleInput) {
    return this.service.updateRule(id, input);
  }

  @Delete('rules/:id')
  deleteRule(@Param('id') id: string) {
    return this.service.deleteRule(id);
  }

  @Get('mapping-templates')
  listMappingTemplates() {
    return this.service.listMappingTemplates();
  }

  @Delete('mapping-templates/:id')
  deleteMappingTemplate(@Param('id') id: string) {
    return this.service.deleteMappingTemplate(id);
  }
}
