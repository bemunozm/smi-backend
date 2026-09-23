import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Roles } from '@thallesp/nestjs-better-auth';
import { diskStorage } from 'multer';
import type { Request } from 'express';
import { existsSync, mkdirSync } from 'fs';
import { extname, join } from 'path';

import { ROLES } from '../auth/roles';

export const UPLOAD_DIR = join(process.cwd(), 'uploads');
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

/**
 * Acepta imágenes (fotos de equipo, evidencias de terreno) y PDF (documentos
 * de equipo: revisión técnica, seguro, permisos, certificaciones) — rechaza
 * el resto con el mismo 400 que ya usaba el endpoint. Exportada aparte (en
 * vez de quedar inline en el decorator) para poder testearla sin levantar el
 * `FileInterceptor`/multer completo.
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

@Controller('uploads')
export class UploadsController {
  @Post()
  @Roles([ROLES.SUPERVISOR, ROLES.ADMIN])
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: UPLOAD_DIR,
        filename: (_req, file, cb) => {
          const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
          cb(null, `${unique}${extname(file.originalname)}`);
        },
      }),
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: imageOrPdfFileFilter,
    }),
  )
  upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('No se recibió archivo');
    return {
      data: { url: `/uploads/${file.filename}` },
      message: 'Archivo subido',
    };
  }
}
