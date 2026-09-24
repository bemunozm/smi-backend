import { Module } from '@nestjs/common';

import { OcrController } from './ocr.controller';
import { OcrService } from './ocr.service';

/** Módulo OCR (Núcleo): lectura server-side de litros desde foto de surtidor. Ver `ocr.service.ts` para el pipeline y notas de deploy. */
@Module({
  controllers: [OcrController],
  providers: [OcrService],
  exports: [OcrService],
})
export class OcrModule {}
