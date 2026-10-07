import { Module } from '@nestjs/common';

import { InventoryModule } from '../inventory/inventory.module';
import { StorageModule } from '../storage/storage.module';
import { ActividadesController } from './actividades.controller';
import { ActividadesService } from './actividades.service';
import { IntervencionesController } from './intervenciones.controller';
import { IntervencionesService } from './intervenciones.service';
import { OrdenesController } from './ordenes.controller';
import { OrdenesService } from './ordenes.service';
import { UmbralesController } from './umbrales.controller';
import { UmbralesService } from './umbrales.service';

@Module({
  // Inventory: el cierre de una intervención descuenta stock vía
  // `StockService.issue` (único camino permitido para mover existencias).
  // Storage: la foto del cierre (claim/sign, patrón hallazgos).
  imports: [InventoryModule, StorageModule],
  controllers: [
    OrdenesController,
    IntervencionesController,
    UmbralesController,
    ActividadesController,
  ],
  providers: [
    OrdenesService,
    IntervencionesService,
    UmbralesService,
    ActividadesService,
  ],
})
export class MantenimientoModule {}
