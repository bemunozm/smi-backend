import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Put,
  Query,
} from '@nestjs/common';
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../../auth/roles';
import { SaveMaintenancePlanDto } from './dto/save-maintenance-plan.dto';
import { SetMaintenanceRecordDto } from './dto/set-maintenance-record.dto';
import { MaintenancePlansService } from './maintenance-plans.service';

/** Quién mira las pautas: también el supervisor, que ve los equipos en faena. */
const LECTORES = [ROLES.ADMIN, ROLES.MANTENEDOR, ROLES.SUPERVISOR];

/**
 * Pautas de mantención preventiva por equipo, una por equipo (`:equipmentId`).
 * Todas las lecturas cuelgan de `/maintenance-plans` para que el frontend
 * limpie su caché sin conexión de una sola raíz. `status` va declarado antes
 * que `:equipmentId` para que Nest no lo tome como un id.
 */
@Controller('maintenance-plans')
export class MaintenancePlansController {
  constructor(private readonly service: MaintenancePlansService) {}

  /** Próxima mantención de cada equipo con pauta (columna de la tabla de Equipos). */
  @Get('status')
  @Roles(LECTORES)
  async statusForAll() {
    return { data: await this.service.statusForAll(), message: 'ok' };
  }

  @Get(':equipmentId')
  @Roles(LECTORES)
  async findOne(@Param('equipmentId') equipmentId: string) {
    return {
      data: await this.service.findForEquipment(equipmentId),
      message: 'ok',
    };
  }

  /** Solo la próxima mantención con sus operaciones: base de las tareas preventivas. */
  @Get(':equipmentId/next')
  @Roles(LECTORES)
  async next(@Param('equipmentId') equipmentId: string) {
    return {
      data: await this.service.nextForEquipment(equipmentId),
      message: 'ok',
    };
  }

  /**
   * Una vuelta del ciclo de mantenciones (`?cycle=2`); sin `cycle`, la que
   * está en curso. Es lo que muestra «Ciclo de mantenciones» en la ficha.
   */
  @Get(':equipmentId/cycle')
  @Roles(LECTORES)
  async cycle(
    @Param('equipmentId') equipmentId: string,
    @Query('cycle', new ParseIntPipe({ optional: true })) cycle?: number,
  ) {
    return {
      data: await this.service.getCycle(equipmentId, cycle),
      message: 'ok',
    };
  }

  /**
   * Marca o desmarca una operación como hecha en un hito de una vuelta del
   * ciclo. Solo el mantenedor, que es quien la hace; el resto la ve en solo
   * lectura. Quién la marca sale de la sesión. Base para que las órdenes
   * preventivas del mantenedor la registren solas al cerrarse.
   */
  @Put(':equipmentId/records')
  @Roles([ROLES.MANTENEDOR])
  async setRecord(
    @Param('equipmentId') equipmentId: string,
    @Body() dto: SetMaintenanceRecordDto,
    @Session() session: UserSession,
  ) {
    const editor = {
      id: session.user.id,
      name: session.user.name?.trim() || session.user.email,
    };
    return {
      data: await this.service.setRecord(equipmentId, dto, editor),
      message: dto.done ? 'Mantención registrada' : 'Registro quitado',
    };
  }

  @Get(':equipmentId/changes')
  @Roles(LECTORES)
  async changes(@Param('equipmentId') equipmentId: string) {
    return {
      data: await this.service.findChanges(equipmentId),
      message: 'ok',
    };
  }

  /** La pauta se guarda entera, como se edita. Quién la cambia sale de la sesión. */
  @Put(':equipmentId')
  @Roles([ROLES.ADMIN, ROLES.MANTENEDOR])
  async save(
    @Param('equipmentId') equipmentId: string,
    @Body() dto: SaveMaintenancePlanDto,
    @Session() session: UserSession,
  ) {
    const editor = {
      id: session.user.id,
      name: session.user.name?.trim() || session.user.email,
    };
    return {
      data: await this.service.save(equipmentId, dto, editor),
      message: 'Pauta guardada',
    };
  }
}
