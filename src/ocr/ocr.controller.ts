import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Roles } from '@thallesp/nestjs-better-auth';
import { memoryStorage } from 'multer';
import type { Request } from 'express';

import { ROLES } from '../auth/roles';
import { OcrService, type OcrFuelReadingResult } from './ocr.service';

/**
 * Filtro propio del módulo OCR — NO reutiliza `imageOrPdfFileFilter` de
 * `uploads/`: la foto de litros nunca se persiste en disco (se procesa
 * en memoria y se descarta, ver `memoryStorage()` abajo), solo acepta
 * imágenes (no PDF), y mantener el módulo autocontenido facilita separarlo
 * en su propio PR más adelante (ver instrucciones de la tarea).
 */
export function fuelReadingImageFilter(
  _req: Request,
  file: Express.Multer.File,
  callback: (error: Error | null, acceptFile: boolean) => void,
): void {
  if (file.mimetype.startsWith('image/')) {
    callback(null, true);
  } else {
    callback(new BadRequestException('Solo se permiten imágenes'), false);
  }
}

@Controller('ocr')
export class OcrController {
  constructor(private readonly ocrService: OcrService) {}

  /**
   * Lee los litros de una foto de surtidor (display 7 segmentos) con un
   * ensemble local de dos modelos ONNX (Florence-2 fine-tuneado + CRNN) y
   * devuelve un `status` de acuerdo entre ambos — el front decide autollenar
   * o pedir revisión en base a `status`, no a una confianza por dígito (este
   * pipeline no produce desglose por dígito, ver `OcrService`):
   *   - CONFIRMED: los dos modelos coinciden exactamente.
   *   - REVIEW: difieren, o solo uno pudo leer — `value` trae la lectura
   *     sugerida (Florence primero) para autollenar con aviso de verificar.
   *   - UNREADABLE: ninguno pudo leer.
   * Nunca falla con 500: en degradación (worker python caído, timeout, etc.)
   * devuelve `value: null, status: 'UNREADABLE', confidence: 0` (ver
   * `OcrService.readFuelValueFrom`).
   */
  @Post('fuel-reading')
  @Roles([ROLES.SUPERVISOR, ROLES.ADMIN])
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 8 * 1024 * 1024 },
      fileFilter: fuelReadingImageFilter,
    }),
  )
  async fuelReading(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('No se recibió archivo');

    const result = await this.ocrService.readFuelValueFrom(
      file.buffer,
      file.originalname,
    );

    return {
      data: result,
      message: fuelReadingMessage(result.status),
    };
  }
}

function fuelReadingMessage(status: OcrFuelReadingResult['status']): string {
  switch (status) {
    case 'CONFIRMED':
      return 'Lectura de litros confirmada';
    case 'REVIEW':
      return 'Lectura de litros sugerida, verificá el valor';
    case 'UNREADABLE':
      return 'No se pudo leer el display automáticamente';
  }
}
