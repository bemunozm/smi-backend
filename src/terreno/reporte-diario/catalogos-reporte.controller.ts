import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Roles } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../../auth/roles';
import { CatalogosReporteService } from './catalogos-reporte.service';
import {
  CreateEmpresaExternaDto,
  UpdateEmpresaExternaDto,
} from './dto/empresa-externa.dto';

@Controller()
export class CatalogosReporteController {
  constructor(private readonly service: CatalogosReporteService) {}

  @Get('plantas')
  async plantas() {
    return { data: await this.service.plantas(), message: 'ok' };
  }

  /** Las activas: las que marca el supervisor en el reporte diario. */
  @Get('empresas-externas')
  async empresasExternas() {
    return { data: await this.service.empresasExternas(), message: 'ok' };
  }

  /** Todas, con cuántos reportes las usan: CRUD del administrador. */
  @Get('empresas-externas/admin')
  @Roles([ROLES.ADMIN])
  async empresasExternasAdmin() {
    return { data: await this.service.empresasExternasAdmin(), message: 'ok' };
  }

  @Post('empresas-externas')
  @Roles([ROLES.ADMIN])
  async crearEmpresaExterna(@Body() dto: CreateEmpresaExternaDto) {
    return {
      data: await this.service.crearEmpresaExterna(dto),
      message: 'Empresa agregada',
    };
  }

  @Patch('empresas-externas/:id')
  @Roles([ROLES.ADMIN])
  async actualizarEmpresaExterna(
    @Param('id') id: string,
    @Body() dto: UpdateEmpresaExternaDto,
  ) {
    return {
      data: await this.service.actualizarEmpresaExterna(id, dto),
      message: 'Empresa actualizada',
    };
  }

  @Delete('empresas-externas/:id')
  @Roles([ROLES.ADMIN])
  async eliminarEmpresaExterna(@Param('id') id: string) {
    const resultado = await this.service.eliminarEmpresaExterna(id);
    return {
      data: resultado,
      message: resultado.eliminada
        ? 'Empresa eliminada'
        : 'La empresa tiene reportes: se desactivó y ya no sale en el reporte diario',
    };
  }
}
