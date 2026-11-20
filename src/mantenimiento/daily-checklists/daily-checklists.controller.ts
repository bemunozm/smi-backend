import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ChecklistStatus } from '@prisma/client';
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../../auth/roles';
import { isValidDateOnly, parseDateOnlyUtc } from '../../shifts/date-only';
import { DailyChecklistsService } from './daily-checklists.service';
import { ResubmitDailyChecklistDto } from './dto/resubmit-daily-checklist.dto';
import { ReviewDailyChecklistDto } from './dto/review-daily-checklist.dto';
import { SubmitDailyChecklistDto } from './dto/submit-daily-checklist.dto';

function editorDe(session: UserSession) {
  return {
    id: session.user.id,
    name: session.user.name?.trim() || session.user.email,
  };
}

/**
 * Lo ven el mantenedor (lo llena), el supervisor (lo valida), el administrador
 * y la secretaria (solo lectura: el listado de «Chequeos diarios» del panel).
 */
const LECTORES = [
  ROLES.MANTENEDOR,
  ROLES.SUPERVISOR,
  ROLES.ADMIN,
  ROLES.SECRETARIA,
];

/** Largo máximo (en días, ambos extremos incluidos) del rango `from`–`to`. */
export const MAX_RANGE_DAYS = 92;
const MS_DIA = 24 * 60 * 60 * 1000;

/**
 * Chequeo diario del mantenedor (Módulo 2). `items` va declarado antes que
 * `:id` para que Nest no lo tome como un id.
 */
@Controller('daily-checklists')
export class DailyChecklistsController {
  constructor(private readonly service: DailyChecklistsService) {}

  /** El catálogo de ítems vigente, en el orden de la planilla. */
  @Get('items')
  @Roles(LECTORES)
  async items() {
    return { data: await this.service.items(), message: 'ok' };
  }

  /**
   * Los chequeos de un día (`?date=YYYY-MM-DD`) o de un rango de días
   * (`?from=YYYY-MM-DD&to=YYYY-MM-DD`, inclusive, hasta `MAX_RANGE_DAYS`), de un
   * equipo o en ciertos estados (`?status=SUBMITTED,REJECTED`: los pendientes
   * del supervisor). `date` y `from`/`to` no se combinan.
   */
  @Get()
  @Roles(LECTORES)
  async list(
    @Query('date') date?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('equipmentId') equipmentId?: string,
    @Query('status') status?: string,
  ) {
    if (date && !isValidDateOnly(date)) {
      throw new BadRequestException('La fecha tiene que ser YYYY-MM-DD.');
    }
    if (date && (from || to)) {
      throw new BadRequestException(
        'Usa una fecha (date) o un rango (from y to), no las dos.',
      );
    }
    if (from || to) {
      if (!from || !to) {
        throw new BadRequestException('El rango necesita desde y hasta.');
      }
      if (!isValidDateOnly(from) || !isValidDateOnly(to)) {
        throw new BadRequestException(
          'Las fechas del rango tienen que ser YYYY-MM-DD.',
        );
      }
      if (from > to) {
        throw new BadRequestException(
          'La fecha de inicio no puede ser posterior a la de término.',
        );
      }
      const dias =
        Math.round(
          (parseDateOnlyUtc(to).getTime() - parseDateOnlyUtc(from).getTime()) /
            MS_DIA,
        ) + 1;
      if (dias > MAX_RANGE_DAYS) {
        throw new BadRequestException(
          `El rango puede abarcar hasta ${MAX_RANGE_DAYS} días.`,
        );
      }
    }
    const estados = status ? status.split(',').map((e) => e.trim()) : [];
    const validos = Object.values(ChecklistStatus) as string[];
    if (estados.some((e) => !validos.includes(e))) {
      throw new BadRequestException(
        `El estado tiene que ser ${validos.join(', ')}.`,
      );
    }
    return {
      data: await this.service.list({
        date,
        from,
        to,
        equipmentId,
        status: estados as ChecklistStatus[],
      }),
      message: 'ok',
    };
  }

  @Get(':id')
  @Roles(LECTORES)
  async findOne(@Param('id') id: string) {
    return { data: await this.service.findOne(id), message: 'ok' };
  }

  /**
   * Envía el chequeo de un equipo al supervisor. Solo el mantenedor, que es
   * quien lo hace; quién lo envía sale de la sesión.
   */
  @Post()
  @Roles([ROLES.MANTENEDOR])
  async submit(
    @Body() dto: SubmitDailyChecklistDto,
    @Session() session: UserSession,
  ) {
    return {
      data: await this.service.submit(dto, editorDe(session)),
      message: 'Chequeo enviado al supervisor',
    };
  }

  /** El mantenedor corrige un chequeo rechazado y lo vuelve a enviar. */
  @Put(':id')
  @Roles([ROLES.MANTENEDOR])
  async resubmit(
    @Param('id') id: string,
    @Body() dto: ResubmitDailyChecklistDto,
    @Session() session: UserSession,
  ) {
    return {
      data: await this.service.resubmit(id, dto, editorDe(session)),
      message: 'Chequeo corregido y enviado al supervisor',
    };
  }

  /**
   * Módulo 3 · R25: el supervisor acepta (libera el equipo) o rechaza con
   * comentario. Solo el supervisor, que es quien prueba el equipo en terreno.
   */
  @Post(':id/review')
  @Roles([ROLES.SUPERVISOR])
  async review(
    @Param('id') id: string,
    @Body() dto: ReviewDailyChecklistDto,
    @Session() session: UserSession,
  ) {
    const res = await this.service.review(id, dto, editorDe(session));
    return {
      data: res,
      message:
        dto.decision === 'ACCEPTED'
          ? 'Chequeo aceptado: el equipo quedó liberado'
          : 'Chequeo rechazado: vuelve al mantenedor',
    };
  }
}
