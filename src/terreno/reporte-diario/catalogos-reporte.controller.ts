import { Controller, Get } from '@nestjs/common';

import { CatalogosReporteService } from './catalogos-reporte.service';

@Controller()
export class CatalogosReporteController {
  constructor(private readonly service: CatalogosReporteService) {}

  @Get('plantas')
  async plantas() {
    return { data: await this.service.plantas(), message: 'ok' };
  }

  @Get('empresas-externas')
  async empresasExternas() {
    return { data: await this.service.empresasExternas(), message: 'ok' };
  }
}
