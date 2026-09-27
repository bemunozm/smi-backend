import {
  BadRequestException,
  Controller,
  Post,
  UnsupportedMediaTypeException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Roles } from '@thallesp/nestjs-better-auth';
import { memoryStorage } from 'multer';
import type { Request } from 'express';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ROLES } from '../auth/roles';
import { detectFileSignature } from '../storage/file-signature';

export const UPLOAD_DIR = join(process.cwd(), 'uploads');
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

// Alineado con `/api/files` y `/api/ocr/fuel-reading` (ver Diseño del RFC
// R2-storage y hallazgo M2 de la revisión de seguridad) — antes 5MB.
const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024;

/**
 * Pre-filtro liviano por `mimetype` del multipart (mismo patrón que
 * `FilesController.imageOrPdfMimeFilter`) — rechaza de entrada lo que ni
 * siquiera DICE ser imagen/PDF, antes de bufferear el body completo en
 * memoria. NO es la validación real: un cliente puede mentir el mimetype
 * (ej. un .html renombrado a .png declara `image/png`) — esa validación de
 * verdad ocurre por bytes reales en `detectFileSignature`, dentro del
 * handler (ver hallazgo ALTO A1 de la revisión de seguridad: antes este
 * endpoint confiaba en la extensión de `file.originalname` y en este mismo
 * mimetype falsificable para decidir qué guardar en disco).
 */
export function imageOrPdfFileFilter(
  _req: Request,
  file: Express.Multer.File,
  callback: (error: Error | null, acceptFile: boolean) => void,
): void {
  if (
    file.mimetype.startsWith('image/') ||
    file.mimetype === 'application/pdf'
  ) {
    callback(null, true);
  } else {
    callback(new BadRequestException('Solo se permiten imágenes o PDF'), false);
  }
}

interface UploadResponse {
  data: { url: string };
  message: string;
}

@Controller('uploads')
export class UploadsController {
  @Post()
  @Roles([ROLES.SUPERVISOR, ROLES.ADMIN])
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: MAX_FILE_SIZE_BYTES,
        files: 1,
        fields: 0,
        parts: 1,
        fieldNameSize: 50,
        headerPairs: 20,
      },
      fileFilter: imageOrPdfFileFilter,
    }),
  )
  async upload(
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<UploadResponse> {
    if (!file) throw new BadRequestException('No se recibió archivo');

    // Validación real por bytes (nunca por `file.originalname`/mimetype del
    // cliente, ambos falsificables) — mismo mecanismo que `StorageService.putTmp`.
    const signature = detectFileSignature(file.buffer);
    if (!signature) {
      throw new UnsupportedMediaTypeException(
        'El archivo no es una imagen (JPEG/PNG/WebP) ni un PDF válido',
      );
    }

    // Nombre generado en el servidor — nunca a partir del nombre/extensión
    // que mandó el cliente, para no poder colar un `.html`/`.svg` servible.
    const filename = `${Date.now()}-${randomBytes(8).toString('hex')}.${signature.ext}`;
    await writeFile(join(UPLOAD_DIR, filename), file.buffer);

    return {
      data: { url: `/uploads/${filename}` },
      message: 'Archivo subido',
    };
  }
}
