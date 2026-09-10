import { Module } from '@nestjs/common';

import { SucursalesController } from './sucursales.controller';
import { SucursalesService } from './sucursales.service';

/**
 * Dominio Sucursales (Joaquín, RFC-11).
 *
 * `SucursalesService` se EXPORTA porque `InventarioService` lo necesita para
 * dos cosas en cada movimiento: resolver la bodega por defecto cuando el
 * llamador no la indica, y validar que la bodega indicada esté operativa. Esa
 * regla vive acá y no duplicada en Inventario.
 */
@Module({
  controllers: [SucursalesController],
  providers: [SucursalesService],
  exports: [SucursalesService],
})
export class SucursalesModule {}
