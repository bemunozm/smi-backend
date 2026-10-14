import { Module } from '@nestjs/common';

import { CatalogosReporteController } from './catalogos-reporte.controller';
import { CatalogosReporteService } from './catalogos-reporte.service';

@Module({
  controllers: [CatalogosReporteController],
  providers: [CatalogosReporteService],
})
export class ReporteDiarioModule {}
