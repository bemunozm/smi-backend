import { Module } from '@nestjs/common';

import { AdBlueStockService } from './adblue-stock.service';
import { CategoriesController } from './categories/categories.controller';
import { CategoriesService } from './categories/categories.service';
import { ItemsController } from './items/items.controller';
import { ItemsService } from './items/items.service';
import { MovementsController } from './movements/movements.controller';
import { MovementsService } from './movements/movements.service';
import { StockController } from './stock/stock.controller';
import { StockService } from './stock.service';

/**
 * Dominio Inventario.
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
  providers: [
    StockService,
    AdBlueStockService,
    ItemsService,
    MovementsService,
    CategoriesService,
  ],
  // `AdBlueStockService` también se exporta: Shifts y Terreno (combustible)
  // descuentan el AdBlue declarado sin conocer el kardex ni la heurística del
  // ítem.
  exports: [StockService, AdBlueStockService],
})
export class InventoryModule {}
