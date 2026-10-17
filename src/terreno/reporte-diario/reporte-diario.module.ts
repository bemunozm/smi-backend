import { Module } from '@nestjs/common';
import { ChangeLogModule } from '../../change-log/change-log.module';
import { CatalogosReporteController } from './catalogos-reporte.controller';
import { CatalogosReporteService } from './catalogos-reporte.service';
import { ReporteDiarioController } from './reporte-diario.controller';
import { ReporteDiarioService } from './reporte-diario.service';

@Module({
  imports: [ChangeLogModule],
  controllers: [CatalogosReporteController, ReporteDiarioController],
  providers: [CatalogosReporteService, ReporteDiarioService],
})
export class ReporteDiarioModule {}
