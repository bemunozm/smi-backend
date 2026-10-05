import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Redirect,
} from '@nestjs/common';
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../auth/roles';
import { CreateShiftReportDto } from './dto/create-shift-report.dto';
import { ShiftReportsService } from './shift-reports.service';

function assertNonEmptyId(id: string): void {
  if (!id || id.trim().length === 0) {
    throw new BadRequestException('El parámetro "id" no puede estar vacío');
  }
}

/**
 * Reporte de salida de turno (RFC Supervisión en Terreno). Mismo
 * gate de roles que `ShiftCardsController` — el reporte solo tiene sentido
 * para quien puede abrir/cerrar tarjetas.
 */
@Controller('shift-reports')
@Roles([ROLES.SUPERVISOR, ROLES.ADMIN])
export class ShiftReportsController {
  constructor(private readonly service: ShiftReportsService) {}

  @Post()
  async create(
    @Body() dto: CreateShiftReportDto,
    @Session() session: UserSession,
  ) {
    return {
      data: await this.service.create(dto, session),
      message: 'Reporte generado',
    };
  }

  /**
   * "Descargar": 302 a una URL RECIÉN firmada — mismo patrón que
   * `EquipmentDocumentController.getFile`. Los errores (403/404) siguen el
   * `{data,message}` del filtro global: `@Redirect()` solo intercepta el
   * `return`, no las excepciones.
   */
  @Get(':id/file')
  @Redirect()
  async getFile(
    @Param('id') id: string,
    @Session() session: UserSession,
  ): Promise<{ url: string; statusCode: number }> {
    assertNonEmptyId(id);
    const url = await this.service.getSignedFileUrl(id, session);
    return { url, statusCode: HttpStatus.FOUND };
  }
}
