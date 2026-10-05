import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../auth/roles';
import {
  EXPECTED_HEADER,
  parseExpectedHeader,
} from '../common/concurrency/expected-fields';
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
    @Session() session: UserSession,
  ): Promise<ActividadDetailResponse> {
    const data = await this.actividadesService.create(dto, session.user.id);
    return { data, message: 'Actividad creada' };
  }

  @Patch(':id')
  @Roles([ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.MANTENEDOR])
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateActividadDto,
    @Headers(EXPECTED_HEADER) expected?: string,
  ): Promise<ActividadDetailResponse> {
    assertNonEmptyId(id);
    const data = await this.actividadesService.update(
      id,
      dto,
      parseExpectedHeader(expected),
    );
    return { data, message: 'Actividad actualizada' };
  }
}
