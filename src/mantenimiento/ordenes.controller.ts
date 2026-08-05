import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Roles } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../auth/roles';
import { assertNonEmptyId } from './common/assert-non-empty-id';
import { CreateOrdenDto } from './dto/create-orden.dto';
import { FindOrdenesQueryDto } from './dto/find-ordenes-query.dto';
import type { OrdenResponseDto } from './dto/orden-response.dto';
import type { TareaResponseDto } from './dto/tarea-response.dto';
import { ToggleTareaDto } from './dto/toggle-tarea.dto';
import { UpdateOrdenDto } from './dto/update-orden.dto';
import { OrdenesService } from './ordenes.service';

interface OrdenListResponse {
  data: OrdenResponseDto[];
  message: string;
}

interface OrdenDetailResponse {
  data: OrdenResponseDto;
  message: string;
}

interface TareaDetailResponse {
  data: TareaResponseDto;
  message: string;
}

@Controller('mantenimiento/ordenes')
export class OrdenesController {
  constructor(private readonly ordenesService: OrdenesService) {}

  @Get()
  @Roles([ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.MANTENEDOR])
  async findAll(
    @Query() query: FindOrdenesQueryDto,
  ): Promise<OrdenListResponse> {
    const data = await this.ordenesService.findAll(query.estado);
    return { data, message: 'ok' };
  }

  @Get(':id')
  @Roles([ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.MANTENEDOR])
  async findOne(@Param('id') id: string): Promise<OrdenDetailResponse> {
    assertNonEmptyId(id);
    const data = await this.ordenesService.findOne(id);
    return { data, message: 'ok' };
  }

  @Post()
  @Roles([ROLES.ADMIN, ROLES.SUPERVISOR])
  async create(@Body() dto: CreateOrdenDto): Promise<OrdenDetailResponse> {
    const data = await this.ordenesService.create(dto);
    return { data, message: 'Orden de trabajo creada' };
  }

  @Patch(':id')
  @Roles([ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.MANTENEDOR])
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateOrdenDto,
  ): Promise<OrdenDetailResponse> {
    assertNonEmptyId(id);
    const data = await this.ordenesService.update(id, dto);
    return { data, message: 'Orden de trabajo actualizada' };
  }

  @Patch(':ordenId/tareas/:tareaId')
  @Roles([ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.MANTENEDOR])
  async toggleTarea(
    @Param('ordenId') ordenId: string,
    @Param('tareaId') tareaId: string,
    @Body() dto: ToggleTareaDto,
  ): Promise<TareaDetailResponse> {
    assertNonEmptyId(ordenId, 'ordenId');
    assertNonEmptyId(tareaId, 'tareaId');
    const data = await this.ordenesService.toggleTarea(
      ordenId,
      tareaId,
      dto.hecha,
    );
    return { data, message: 'Tarea actualizada' };
  }
}
