import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { Roles } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../auth/roles';
import { ActividadesService } from './actividades.service';
import { assertNonEmptyId } from './common/assert-non-empty-id';
import type { ActividadResponseDto } from './dto/actividad-response.dto';
import { CreateActividadDto } from './dto/create-actividad.dto';
import { UpdateActividadDto } from './dto/update-actividad.dto';

interface ActividadListResponse {
  data: ActividadResponseDto[];
  message: string;
}

interface ActividadDetailResponse {
  data: ActividadResponseDto;
  message: string;
}

@Controller('mantenimiento/actividades')
export class ActividadesController {
  constructor(private readonly actividadesService: ActividadesService) {}

  @Get()
  @Roles([ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.MANTENEDOR])
  async findAll(): Promise<ActividadListResponse> {
    const data = await this.actividadesService.findAll();
    return { data, message: 'ok' };
  }

  @Post()
  @Roles([ROLES.ADMIN, ROLES.SUPERVISOR])
  async create(
    @Body() dto: CreateActividadDto,
  ): Promise<ActividadDetailResponse> {
    const data = await this.actividadesService.create(dto);
    return { data, message: 'Actividad creada' };
  }

  @Patch(':id')
  @Roles([ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.MANTENEDOR])
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateActividadDto,
  ): Promise<ActividadDetailResponse> {
    assertNonEmptyId(id);
    const data = await this.actividadesService.update(id, dto);
    return { data, message: 'Actividad actualizada' };
  }
}
