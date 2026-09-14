import { Module } from '@nestjs/common';

import { CategoriesController } from './categories/categories.controller';
import { CategoriesService } from './categories/categories.service';
import { ItemsController } from './items/items.controller';
import { ItemsService } from './items/items.service';
import { MovementsController } from './movements/movements.controller';
import { MovementsService } from './movements/movements.service';
import { StockController } from './stock/stock.controller';
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
  controllers: [
    ItemsController,
    CategoriesController,
    MovementsController,
    StockController,
  ],
  providers: [StockService, ItemsService, MovementsService, CategoriesService],
  exports: [StockService],
})
export class InventoryModule {}
