import { Controller, Get, Query } from '@nestjs/common';
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../auth/roles';
import { QueryShiftDto } from './dto/query-shift.dto';
import { ShiftsService } from './shifts.service';

/**
 * `GET /api/shifts?date&type` — el turno con sus tarjetas y operadores.
 * Contrato compartido con el Módulo B de Alexander ("lista viva"), ver
 * `ShiftsService.findShifts`.
 */
@Controller('shifts')
@Roles([ROLES.SUPERVISOR, ROLES.ADMIN])
export class ShiftsController {
  constructor(private readonly service: ShiftsService) {}

  @Get()
  async findAll(
    @Query() query: QueryShiftDto,
    @Session() session: UserSession,
  ) {
    return {
      data: await this.service.findShifts(query, session),
      message: 'ok',
    };
  }
}
