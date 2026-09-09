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
import { CreateEquipmentDto } from './dto/create-equipment.dto';
import { QueryEquipmentDto } from './dto/query-equipment.dto';
import {
  UpdateEquipmentDto,
  UpdateEquipmentStatusDto,
} from './dto/update-equipment.dto';
import { EquipmentService } from './equipment.service';

function assertNonEmptyId(id: string): void {
  if (!id || id.trim().length === 0) {
    throw new BadRequestException('El parámetro "id" no puede estar vacío');
  }
}

/**
 * Dominio Flota (Benjamín). El `AuthGuard` global ya exige sesión, así que la
 * LECTURA queda abierta a cualquier rol autenticado: terreno y mantenimiento
 * necesitan listar equipos para sus propios formularios. La ESCRITURA de la
 * ficha es solo ADMIN; el cambio de estado lo comparte con SUPERVISOR
 * (requerimientos §5.2, "Control de Flota").
 */
@Controller('equipment')
export class EquipmentController {
  constructor(private readonly service: EquipmentService) {}

  @Get()
  async findAll(@Query() filtros: QueryEquipmentDto) {
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
  async create(@Body() dto: CreateEquipmentDto) {
    return { data: await this.service.create(dto), message: 'Equipo creado' };
  }

  @Patch(':id')
  @Roles([ROLES.ADMIN])
  async update(@Param('id') id: string, @Body() dto: UpdateEquipmentDto) {
    assertNonEmptyId(id);
    return {
      data: await this.service.update(id, dto),
      message: 'Equipo actualizado',
    };
  }

  @Patch(':id/status')
  @Roles([ROLES.ADMIN, ROLES.SUPERVISOR])
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateEquipmentStatusDto,
  ) {
    assertNonEmptyId(id);
    return {
      data: await this.service.updateStatus(id, dto),
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
