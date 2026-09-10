import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { Roles } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../../auth/roles';
import { QueryStockDto } from './dto/query-stock.dto';
import { SetStockMinimoDto } from './dto/set-stock-minimo.dto';
import { StockService } from './stock.service';

function assertNonEmptyId(id: string): void {
  if (!id || id.trim().length === 0) {
    throw new BadRequestException('El parámetro "id" no puede estar vacío');
  }
}

/**
 * Consulta de inventario por bodega (PROD-11 / RFC-11).
 *
 * El prefijo es `inventario` y no `inventario/stock` para poder exponer también
 * `GET /api/inventario/insumos/:id/stock` sin editar `insumos.controller.ts`
 * (archivo del dominio de Flota/Inventario original). Las dos rutas conviven con
 * las de `InsumosController` porque tienen distinta cantidad de segmentos:
 * `/inventario/insumos/:id` nunca captura `/inventario/insumos/:id/stock`.
 *
 * Lectura para cualquier rol con sesión: saber si el repuesto está en la bodega
 * es justamente lo que necesita el mantenedor antes de pedir material.
 */
@Controller('inventario')
export class StockController {
  constructor(private readonly service: StockService) {}

  @Get('stock')
  async listar(@Query() filtros: QueryStockDto) {
    return { data: await this.service.listar(filtros), message: 'ok' };
  }

  @Get('insumos/:id/stock')
  async desglose(@Param('id') id: string) {
    assertNonEmptyId(id);
    return {
      data: await this.service.desglosePorSucursal(id),
      message: 'ok',
    };
  }

  // `PUT` y no `PATCH`: el umbral se fija completo, no se parchea, y repetir la
  // llamada con el mismo valor deja el mismo estado (idempotente).
  @Put('stock/minimo')
  @Roles([ROLES.ADMIN])
  async setMinimo(@Body() dto: SetStockMinimoDto) {
    await this.service.setStockMinimo(dto);
    return { data: dto, message: 'Stock mínimo de la sucursal actualizado' };
  }
}
