import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../../auth/roles';
import { CreateMovimientoDto } from './dto/create-movimiento.dto';
import { QueryMovimientosDto } from './dto/query-movimientos.dto';
import { MovimientosService } from './movimientos.service';

/**
 * Kardex general (todos los insumos). El kardex de UN insumo vive en
 * `GET /api/inventario/insumos/:id/kardex`.
 */
@Controller('inventario/movimientos')
export class MovimientosController {
  constructor(private readonly service: MovimientosService) {}

  @Get()
  async findAll(@Query() filtros: QueryMovimientosDto) {
    return { data: await this.service.findAll(filtros), message: 'ok' };
  }

  // MANTENEDOR incluido: retira material de bodega para una mantención. El
  // descuento automático desde la bitácora (Joaquín) no pasa por acá, usa
  // `InventarioService.registrarSalida` directamente.
  @Post()
  @Roles([ROLES.ADMIN, ROLES.MANTENEDOR])
  async create(
    @Body() dto: CreateMovimientoDto,
    @Session() session: UserSession,
  ) {
    return {
      data: await this.service.create(dto, session.user.id),
      message: 'Movimiento registrado',
    };
  }
}
