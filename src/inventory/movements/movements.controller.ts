import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../../auth/roles';
import { CreateMovementDto } from './dto/create-movement.dto';
import { QueryMovementsDto } from './dto/query-movements.dto';
import { MovementsService } from './movements.service';

/**
 * Kardex general (todos los ítems). El kardex de UN ítem vive en
 * `GET /api/inventory/items/:id/kardex`.
 */
@Controller('inventory/movements')
export class MovementsController {
  constructor(private readonly service: MovementsService) {}

  @Get()
  async findAll(@Query() filters: QueryMovementsDto) {
    return { data: await this.service.findAll(filters), message: 'ok' };
  }

  // MANTENEDOR incluido: retira material de bodega para una mantención. El
  // descuento automático desde la bitácora no pasa por acá — usa
  // `StockService.issue` directamente, dentro de su propia transacción.
  @Post()
  @Roles([ROLES.ADMIN, ROLES.MANTENEDOR])
  async create(
    @Body() dto: CreateMovementDto,
    @Session() session: UserSession,
  ) {
    return {
      data: await this.service.create(dto, session.user.id),
      message: 'Movimiento registrado',
    };
  }
}
