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

import { ROLES } from '../../auth/roles';
import { CreateCategoryDto } from './dto/create-category.dto';
import { QueryCategoriesDto } from './dto/query-categories.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { CategoriesService } from './categories.service';

function assertNonEmptyId(id: string): void {
  if (!id || id.trim().length === 0) {
    throw new BadRequestException('El parámetro "id" no puede estar vacío');
  }
}

/**
 * Categorías del catálogo (T05 · DEV-29). Lectura para cualquier rol con
 * sesión — el selector del formulario de ítems y el filtro de la pantalla de
 * Inventario las necesitan. La edición es de ADMIN: la taxonomía la mantiene
 * bodega, no cada mantenedor que da de alta una pieza.
 */
@Controller('inventory/categories')
export class CategoriesController {
  constructor(private readonly service: CategoriesService) {}

  @Get()
  async findAll(@Query() filters: QueryCategoriesDto) {
    return { data: await this.service.findAll(filters), message: 'ok' };
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    assertNonEmptyId(id);
    return { data: await this.service.findOne(id), message: 'ok' };
  }

  @Post()
  @Roles([ROLES.ADMIN])
  async create(@Body() dto: CreateCategoryDto) {
    return {
      data: await this.service.create(dto),
      message: 'Categoría creada',
    };
  }

  @Patch(':id')
  @Roles([ROLES.ADMIN])
  async update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    assertNonEmptyId(id);
    return {
      data: await this.service.update(id, dto),
      message: 'Categoría actualizada',
    };
  }

  @Delete(':id')
  @Roles([ROLES.ADMIN])
  async remove(@Param('id') id: string) {
    assertNonEmptyId(id);
    await this.service.remove(id);
    return { data: { id }, message: 'Categoría eliminada' };
  }
}
