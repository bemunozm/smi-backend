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
import { ShiftsService } from './shifts.service';

function assertNonEmptyId(id: string): void {
  if (!id || id.trim().length === 0) {
    throw new BadRequestException('El parámetro "id" no puede estar vacío');
  }
}

/**
 * Reporte de salida de turno. Mismo
 * gate de roles que `ShiftCardsController` — el reporte solo tiene sentido
 * para quien puede abrir/cerrar tarjetas.
 */
@Controller('shift-reports')
@Roles([ROLES.SUPERVISOR, ROLES.ADMIN])
export class ShiftReportsController {
  constructor(
    private readonly service: ShiftReportsService,
    private readonly shifts: ShiftsService,
  ) {}

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
   * Registro de reportes para la vista «Reportes» del administrador.
   * SOBRESCRIBE el gate de clase (SUPERVISOR+ADMIN): el listado completo —de
   * todos los supervisores— es del administrador (y de SECRETARIA, que ve
   * sus mismos reportes), mismo patrón de override por método que
   * `UsersController.findAll`.
   */
  @Roles([ROLES.ADMIN, ROLES.SECRETARIA])
  @Get()
  async list() {
    return { data: await this.service.list(), message: 'ok' };
  }

  /**
   * "Descargar": 302 a una URL RECIÉN firmada — mismo patrón que
   * `EquipmentDocumentController.getFile`. Los errores (403/404) siguen el
   * `{data,message}` del filtro global: `@Redirect()` solo intercepta el
   * `return`, no las excepciones.
   */
  /**
   * «Ver registro»: las tarjetas del turno del reporte, con la misma forma que
   * `GET /shift-cards/mine` — lo que el PDF resume, para verlo (y, en un caso
   * extremo, que el administrador lo corrija con `PATCH /shift-cards/:id`).
   * Son las tarjetas de HOY: si se corrigió una después del envío, el PDF
   * sigue mostrando lo que se envió.
   */
  @Roles([ROLES.ADMIN, ROLES.SECRETARIA])
  @Get(':id/cards')
  async cards(@Param('id') id: string) {
    assertNonEmptyId(id);
    const shiftId = await this.service.shiftIdOf(id);
    return { data: await this.shifts.cardsOfShift(shiftId), message: 'ok' };
  }

  @Roles([ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.SECRETARIA])
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
