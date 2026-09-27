import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { memoryStorage } from 'multer';
import type { Request } from 'express';

import { ROLES } from '../auth/roles';
import { StorageService } from '../storage/storage.service';

const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024;

/**
 * Pre-filtro liviano por `mimetype` del multipart — rechaza de entrada lo
 * que ni siquiera DICE ser imagen/PDF (ahorra bufferear el body completo en
 * memoria). NO es la validación real: un cliente puede mentir el mimetype
 * (ej. un .html renombrado a .jpg declara `image/jpeg`) — esa validación de
 * verdad ocurre por bytes reales en `StorageService.putTmp` (ver
 * `file-signature.ts`). Mismo patrón que `uploads.controller.ts` (legacy).
 */
export function imageOrPdfMimeFilter(
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

interface UploadFileResponse {
  data: { key: string; url: string };
  message: string;
}

// Solo SUPERVISOR/ADMIN suben archivos de Flota (ver Diseño del RFC).
@Roles([ROLES.SUPERVISOR, ROLES.ADMIN])
@Controller('files')
export class FilesController {
  constructor(private readonly storageService: StorageService) {}

  /**
   * Sube un archivo crudo a `tmp/` y devuelve su key + una url firmada para
   * previsualizarlo. El caller (formulario de Flota) todavía no lo asocia a
   * ningún equipo/registro — eso pasa al hacer submit del formulario, cuando
   * el servicio de dominio "reclama" la key (ver `StorageService.claimTmp`,
   * Fase 2, fuera de este módulo).
   */
  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      // `fields:0`/`parts:1` asumen que el cliente manda ÚNICAMENTE la parte
      // `file` (confirmado: `uploadFile`/`uploadImage`/`fuelReadingOcr` del
      // front solo appendean `'file'`) — reduce la superficie de DoS por
      // multipart abusivo (hallazgo MEDIO M2 de la revisión de seguridad).
      limits: {
        fileSize: MAX_FILE_SIZE_BYTES,
        files: 1,
        fields: 0,
        parts: 1,
        fieldNameSize: 50,
        headerPairs: 20,
      },
      fileFilter: imageOrPdfMimeFilter,
      // Nombres de archivo originales con acentos/ñ llegan bien codificados
      // (busboy asume latin1 por defecto si no se le indica lo contrario).
      defParamCharset: 'utf8',
    }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Session() session: UserSession,
  ): Promise<UploadFileResponse> {
    if (!file) {
      throw new BadRequestException('No se recibió archivo');
    }

    const key = await this.storageService.putTmp(session.user.id, file.buffer);
    const url = await this.storageService.sign(key);

    return { data: { key, url }, message: 'Archivo subido' };
  }
}
