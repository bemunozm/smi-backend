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
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../../auth/roles';
import { AjusteInsumoDto } from './dto/ajuste-insumo.dto';
import { CreateInsumoDto } from './dto/create-insumo.dto';
import { QueryInsumosDto } from './dto/query-insumos.dto';
import { UpdateInsumoDto } from './dto/update-insumo.dto';
import { InsumosService } from './insumos.service';

function assertNonEmptyId(id: string): void {
  if (!id || id.trim().length === 0) {
    throw new BadRequestException('El parámetro "id" no puede estar vacío');
  }
}

/**
 * Insumos y repuestos (Amin). Lectura para cualquier rol autenticado — el
 * mantenedor necesita consultar disponibilidad antes de pedir material. La
 * gestión de la ficha y el ajuste por conteo son de ADMIN (bodega).
 */
@Controller('inventario/insumos')
export class InsumosController {
  constructor(private readonly service: InsumosService) {}

  @Get()
  async findAll(@Query() filtros: QueryInsumosDto) {
    return { data: await this.service.findAll(filtros), message: 'ok' };
  }

  // Antes de `:id` — si no, Nest resuelve "resumen" como un id.
  @Get('resumen')
  async resumen() {
    return { data: await this.service.resumen(), message: 'ok' };
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    assertNonEmptyId(id);
    return { data: await this.service.findOne(id), message: 'ok' };
  }

  @Get(':id/kardex')
  async kardex(@Param('id') id: string) {
    assertNonEmptyId(id);
    return { data: await this.service.kardex(id), message: 'ok' };
  }

  @Post()
  @Roles([ROLES.ADMIN])
  async create(@Body() dto: CreateInsumoDto, @Session() session: UserSession) {
    return {
      data: await this.service.create(dto, session.user.id),
      message: 'Insumo creado',
    };
  }

  @Patch(':id')
  @Roles([ROLES.ADMIN])
  async update(@Param('id') id: string, @Body() dto: UpdateInsumoDto) {
    assertNonEmptyId(id);
    return {
      data: await this.service.update(id, dto),
      message: 'Insumo actualizado',
    };
  }

  @Post(':id/ajuste')
  @Roles([ROLES.ADMIN])
  async ajustar(
    @Param('id') id: string,
    @Body() dto: AjusteInsumoDto,
    @Session() session: UserSession,
  ) {
    assertNonEmptyId(id);
    const resultado = await this.service.ajustar(id, dto, session.user.id);
    return {
      data: resultado,
      message: resultado.movimiento
        ? 'Stock ajustado'
        : 'El conteo coincide con el sistema, no se registró movimiento',
    };
  }

  @Delete(':id')
  @Roles([ROLES.ADMIN])
  async remove(@Param('id') id: string) {
    assertNonEmptyId(id);
    await this.service.remove(id);
    return { data: { id }, message: 'Insumo eliminado' };
  }
}
