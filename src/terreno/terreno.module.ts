import { Module } from '@nestjs/common';
import { CombustibleModule } from './combustible/combustible.module';
import { HorometroModule } from './horometro/horometro.module';
import { TrabajosExtraModule } from './trabajos-extra/trabajos-extra.module';
import { HallazgosModule } from './hallazgos/hallazgos.module';
import { ReporteDiarioModule } from './reporte-diario/reporte-diario.module';

@Module({
  imports: [
    CombustibleModule,
    HorometroModule,
    TrabajosExtraModule,
    HallazgosModule,
    ReporteDiarioModule,
  ],
})
export class TerrenoModule {}
