import { Module } from '@nestjs/common';

import { ItemsController } from './items/items.controller';
import { ItemsService } from './items/items.service';
import { MovementsController } from './movements/movements.controller';
import { MovementsService } from './movements/movements.service';
import { StockService } from './stock.service';

/**
 * Dominio Inventario (Joaquín) — RFC-3.
 *
 * `StockService` se EXPORTA porque es el contrato que consumen los otros
 * dominios para mover existencias (Mantenimiento, Actividades y trabajos
 * extraordinarios). Para usarlo: importar `InventoryModule` en el módulo propio
 * e inyectar `StockService`; ver el ejemplo con transacción en su JSDoc.
 */
@Module({
  controllers: [ItemsController, MovementsController],
  providers: [StockService, ItemsService, MovementsService],
  exports: [StockService],
})
export class InventoryModule {}
