import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Roles } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../auth/roles';
import { CreateEquipoDto } from './dto/create-equipo.dto';
import { QueryEquiposDto } from './dto/query-equipos.dto';
import {
  UpdateEquipoDto,
  UpdateEstadoEquipoDto,
} from './dto/update-equipo.dto';
import { EquiposService } from './equipos.service';

function assertNonEmptyId(id: string): void {
  if (!id || id.trim().length === 0) {
    throw new BadRequestException('El parámetro "id" no puede estar vacío');
  }
}

/**
 * Dominio Flota (Amin). El `AuthGuard` global ya exige sesión, así que la
 * LECTURA queda abierta a cualquier rol autenticado: terreno y mantenimiento
 * necesitan listar equipos para sus propios formularios. La ESCRITURA de la
 * ficha es solo ADMIN; el cambio de estado lo comparte con SUPERVISOR
 * (requerimientos §5.2, "Control de Flota").
 */
@Controller('equipos')
export class EquiposController {
  constructor(private readonly service: EquiposService) {}

  @Get()
  async findAll(@Query() filtros: QueryEquiposDto) {
    return { data: await this.service.findAll(filtros), message: 'ok' };
  }

  // Declarado ANTES de `:id` — si no, Nest resuelve "resumen" como un id.
  @Get('resumen')
  async resumen() {
    return { data: await this.service.resumen(), message: 'ok' };
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    assertNonEmptyId(id);
    return { data: await this.service.findOne(id), message: 'ok' };
  }

  @Post()
  @Roles([ROLES.ADMIN])
  async create(@Body() dto: CreateEquipoDto) {
    return { data: await this.service.create(dto), message: 'Equipo creado' };
  }

  @Patch(':id')
  @Roles([ROLES.ADMIN])
  async update(@Param('id') id: string, @Body() dto: UpdateEquipoDto) {
    assertNonEmptyId(id);
    return {
      data: await this.service.update(id, dto),
      message: 'Equipo actualizado',
    };
  }

  @Patch(':id/estado')
  @Roles([ROLES.ADMIN, ROLES.SUPERVISOR])
  async updateEstado(
    @Param('id') id: string,
    @Body() dto: UpdateEstadoEquipoDto,
  ) {
    assertNonEmptyId(id);
    return {
      data: await this.service.updateEstado(id, dto),
      message: 'Estado actualizado',
    };
  }

  @Delete(':id')
  @Roles([ROLES.ADMIN])
  async remove(@Param('id') id: string) {
    assertNonEmptyId(id);
    await this.service.remove(id);
    return { data: { id }, message: 'Equipo eliminado' };
  }
}
