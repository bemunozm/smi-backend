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
import { isValidDateOnly } from '../../shifts/date-only';
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

/** Lo ven el mantenedor (lo llena), el supervisor (lo valida) y el administrador. */
const LECTORES = [ROLES.MANTENEDOR, ROLES.SUPERVISOR, ROLES.ADMIN];

/**
 * Checklist diario del mantenedor (Módulo 2). `items` va declarado antes que
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
   * Los checklists de un día (`?date=YYYY-MM-DD`), de un equipo o en ciertos
   * estados (`?status=SUBMITTED,REJECTED`: los pendientes del supervisor).
   */
  @Get()
  @Roles(LECTORES)
  async list(
    @Query('date') date?: string,
    @Query('equipmentId') equipmentId?: string,
    @Query('status') status?: string,
  ) {
    if (date && !isValidDateOnly(date)) {
      throw new BadRequestException('La fecha tiene que ser YYYY-MM-DD.');
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
   * Envía el checklist de un equipo al supervisor. Solo el mantenedor, que es
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
      message: 'Checklist enviado al supervisor',
    };
  }

  /** El mantenedor corrige un checklist rechazado y lo vuelve a enviar. */
  @Put(':id')
  @Roles([ROLES.MANTENEDOR])
  async resubmit(
    @Param('id') id: string,
    @Body() dto: ResubmitDailyChecklistDto,
    @Session() session: UserSession,
  ) {
    return {
      data: await this.service.resubmit(id, dto, editorDe(session)),
      message: 'Checklist corregido y enviado al supervisor',
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
          ? 'Checklist aceptado: el equipo quedó liberado'
          : 'Checklist rechazado: vuelve al mantenedor',
    };
  }
}
