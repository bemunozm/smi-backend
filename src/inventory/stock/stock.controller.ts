import { Body, Controller, Post, Put } from '@nestjs/common';
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../../auth/roles';
import { StockService } from '../stock.service';
import { SetMinimumDto } from './dto/set-minimum.dto';
import { TransferStockDto } from './dto/transfer-stock.dto';

/**
 * Operaciones sobre la existencia de una bodega. La CONSULTA vive en
 * `GET /api/inventory/items`, que ya devuelve cada ítem con su `stocks[]` por
 * sucursal — no hace falta un endpoint aparte para leer.
 */
@Controller('inventory/stock')
export class StockController {
  constructor(private readonly service: StockService) {}

  /**
   * `PUT` y no `PATCH`: el umbral se fija completo, no se parchea, y repetir la
   * llamada con el mismo valor deja el mismo estado.
   *
   * MANTENEDOR incluido junto a ADMIN: quien sabe cuánto hay que tener en una
   * bodega es quien trabaja con ella. Dejarlo solo en ADMIN es la vía más
   * rápida a que los umbrales nunca se configuren y la alerta no sirva.
   */
  @Put('minimum')
  @Roles([ROLES.ADMIN, ROLES.MANTENEDOR])
  async setMinimum(@Body() dto: SetMinimumDto) {
    return {
      data: await this.service.setMinimum(dto),
      message: 'Stock mínimo actualizado',
    };
  }

  /**
   * Traspaso entre sucursales. ADMIN y SUPERVISOR: mueve existencia entre
   * bodegas, que es una decisión de operación y no de taller. (La autorización
   * definitiva quedó abierta en RFC-3 — si el equipo define otra cosa, se
   * cambia acá.)
   */
  @Post('transfer')
  @Roles([ROLES.ADMIN, ROLES.SUPERVISOR])
  async transfer(
    @Body() dto: TransferStockDto,
    @Session() session: UserSession,
  ) {
    const result = await this.service.transfer(dto, session.user.id);
    return {
      data: result,
      message: `Traspaso registrado: ${dto.quantity} de ${result.sourceBranchName} a ${result.destinationBranchName}`,
    };
  }
}
