import { Module } from '@nestjs/common';

import { ChangeLogModule } from '../change-log/change-log.module';
import { InventoryModule } from '../inventory/inventory.module';
import { StorageModule } from '../storage/storage.module';
import { ActividadesController } from './actividades.controller';
import { MaintenancePlansController } from './maintenance-plans/maintenance-plans.controller';
import { MaintenancePlansService } from './maintenance-plans/maintenance-plans.service';
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
  // ChangeLog: quién cambió qué en la pauta de mantención de un equipo.
  imports: [InventoryModule, StorageModule, ChangeLogModule],
  controllers: [
    OrdenesController,
    IntervencionesController,
    UmbralesController,
    ActividadesController,
    MaintenancePlansController,
  ],
  providers: [
    OrdenesService,
    IntervencionesService,
    UmbralesService,
    ActividadesService,
    MaintenancePlansService,
  ],
})
export class MantenimientoModule {}
