import { Module } from '@nestjs/common';

import { InsumosController } from './insumos/insumos.controller';
import { InsumosService } from './insumos/insumos.service';
import { InventarioService } from './inventario.service';
import { MovimientosController } from './movimientos/movimientos.controller';
import { MovimientosService } from './movimientos/movimientos.service';

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
  controllers: [InsumosController, MovimientosController],
  providers: [InventarioService, InsumosService, MovimientosService],
  exports: [InventarioService],
})
export class InventarioModule {}
