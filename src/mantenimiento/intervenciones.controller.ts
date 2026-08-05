import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Roles } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../auth/roles';
import { assertNonEmptyId } from './common/assert-non-empty-id';
import { CreateIntervencionDto } from './dto/create-intervencion.dto';
import type { IntervencionResponseDto } from './dto/intervencion-response.dto';
import { IntervencionesService } from './intervenciones.service';

interface IntervencionListResponse {
  data: IntervencionResponseDto[];
  message: string;
}

interface IntervencionDetailResponse {
  data: IntervencionResponseDto;
  message: string;
}

// Bitácora de una OT: rutas anidadas bajo /mantenimiento/ordenes/:ordenId.
@Controller('mantenimiento/ordenes/:ordenId/intervenciones')
export class IntervencionesController {
  constructor(private readonly intervencionesService: IntervencionesService) {}

  @Get()
  @Roles([ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.MANTENEDOR])
  async findAll(
    @Param('ordenId') ordenId: string,
  ): Promise<IntervencionListResponse> {
    assertNonEmptyId(ordenId, 'ordenId');
    const data = await this.intervencionesService.findAllByOrden(ordenId);
    return { data, message: 'ok' };
  }

  @Post()
  @Roles([ROLES.MANTENEDOR])
  async create(
    @Param('ordenId') ordenId: string,
    @Body() dto: CreateIntervencionDto,
  ): Promise<IntervencionDetailResponse> {
    assertNonEmptyId(ordenId, 'ordenId');
    const data = await this.intervencionesService.create(ordenId, dto);
    return { data, message: 'Intervención registrada' };
  }
}
