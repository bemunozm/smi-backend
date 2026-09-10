import { Module } from '@nestjs/common';

import { SucursalesModule } from '../sucursales/sucursales.module';

import { InsumosController } from './insumos/insumos.controller';
import { InsumosService } from './insumos/insumos.service';
import { InventarioService } from './inventario.service';
import { MovimientosController } from './movimientos/movimientos.controller';
import { MovimientosService } from './movimientos/movimientos.service';
import { StockController } from './stock/stock.controller';
import { StockService } from './stock/stock.service';

/**
 * Dominio Inventario (Amin).
 *
 * `InventarioService` se EXPORTA porque es el contrato que consumen los otros
 * dominios para descontar stock (Mantenimiento, Actividades y trabajos
 * extraordinarios — guía §5). Para usarlo: importar `InventarioModule` en el
 * módulo propio e inyectar `InventarioService`; ver el ejemplo de uso con
 * transacción en el JSDoc del service.
 */
@Module({
  // `SucursalesModule` provee `SucursalesService`, que `InventarioService` usa
  // para resolver la bodega por defecto y validar que la indicada esté activa.
  imports: [SucursalesModule],
  controllers: [InsumosController, MovimientosController, StockController],
  providers: [
    InventarioService,
    InsumosService,
    MovimientosService,
    StockService,
  ],
  exports: [InventarioService],
})
export class InventarioModule {}
