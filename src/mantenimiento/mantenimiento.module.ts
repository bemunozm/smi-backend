import { Module } from '@nestjs/common';

import { ActividadesController } from './actividades.controller';
import { ActividadesService } from './actividades.service';
import { IntervencionesController } from './intervenciones.controller';
import { IntervencionesService } from './intervenciones.service';
import { OrdenesController } from './ordenes.controller';
import { OrdenesService } from './ordenes.service';
import { UmbralesController } from './umbrales.controller';
import { UmbralesService } from './umbrales.service';

@Module({
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
