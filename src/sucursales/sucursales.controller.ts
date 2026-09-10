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
import { CreateSucursalDto } from './dto/create-sucursal.dto';
import { QuerySucursalesDto } from './dto/query-sucursales.dto';
import { UpdateSucursalDto } from './dto/update-sucursal.dto';
import { SucursalesService } from './sucursales.service';

function assertNonEmptyId(id: string): void {
  if (!id || id.trim().length === 0) {
    throw new BadRequestException('El parámetro "id" no puede estar vacío');
  }
}

/**
 * Bodegas (RFC-11). La LECTURA la necesita cualquier rol autenticado: es el
 * selector de la pantalla de stock y del formulario de movimientos. La gestión
 * del maestro de sucursales es de ADMIN.
 */
@Controller('sucursales')
export class SucursalesController {
  constructor(private readonly service: SucursalesService) {}

  @Get()
  async findAll(@Query() filtros: QuerySucursalesDto) {
    return { data: await this.service.findAll(filtros), message: 'ok' };
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    assertNonEmptyId(id);
    return { data: await this.service.findOne(id), message: 'ok' };
  }

  @Post()
  @Roles([ROLES.ADMIN])
  async create(@Body() dto: CreateSucursalDto) {
    return { data: await this.service.create(dto), message: 'Sucursal creada' };
  }

  @Patch(':id')
  @Roles([ROLES.ADMIN])
  async update(@Param('id') id: string, @Body() dto: UpdateSucursalDto) {
    assertNonEmptyId(id);
    return {
      data: await this.service.update(id, dto),
      message: 'Sucursal actualizada',
    };
  }

  @Delete(':id')
  @Roles([ROLES.ADMIN])
  async remove(@Param('id') id: string) {
    assertNonEmptyId(id);
    await this.service.remove(id);
    return { data: { id }, message: 'Sucursal eliminada' };
  }
}
