import { Module } from '@nestjs/common';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationService } from './reconciliation.service';
import { VisionExtractionService } from './vision-extraction.service';
import { PaddleOcrService } from './ocr/paddle-ocr.service';
import { ConfirmedSettlementService } from './confirmed-settlement.service';
import { SettlementAnalysisService } from './settlement-analysis.service';

@Module({
  controllers: [ReconciliationController],
  providers: [
    ReconciliationService,
    VisionExtractionService,
    PaddleOcrService,
    ConfirmedSettlementService,
    SettlementAnalysisService,
  ],
})
export class ReconciliationModule {}
