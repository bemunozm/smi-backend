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
import { BranchService } from './branch.service';
import { CreateBranchDto } from './dto/create-branch.dto';
import { QueryBranchDto } from './dto/query-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';

function assertNonEmptyId(id: string): void {
  if (!id || id.trim().length === 0) {
    throw new BadRequestException('El parámetro "id" no puede estar vacío');
  }
}

/**
 * Dominio Plataforma (Benjamín): sucursales/bodegas base. La LECTURA queda
 * abierta a cualquier rol autenticado — la usan los selectores de Flota
 * (`Equipment.homeBranch`) y, a futuro, de Inventario. La ESCRITURA es
 * ADMIN/SUPERVISOR, mismo criterio que el cambio de estado de `Equipment`.
 */
@Controller('branches')
export class BranchController {
  constructor(private readonly service: BranchService) {}

  @Get()
  async findAll(@Query() filtros: QueryBranchDto) {
    return { data: await this.service.findAll(filtros), message: 'ok' };
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    assertNonEmptyId(id);
    return { data: await this.service.findOne(id), message: 'ok' };
  }

  @Post()
  @Roles([ROLES.ADMIN, ROLES.SUPERVISOR])
  async create(@Body() dto: CreateBranchDto) {
    return {
      data: await this.service.create(dto),
      message: 'Sucursal creada',
    };
  }

  @Patch(':id')
  @Roles([ROLES.ADMIN, ROLES.SUPERVISOR])
  async update(@Param('id') id: string, @Body() dto: UpdateBranchDto) {
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
