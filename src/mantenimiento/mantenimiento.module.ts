import { Module } from '@nestjs/common';

import { ChangeLogModule } from '../change-log/change-log.module';
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
  imports: [ChangeLogModule],
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
