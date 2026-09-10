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
import { AdjustStockDto } from './dto/adjust-stock.dto';
import { CreateItemDto } from './dto/create-item.dto';
import { QueryItemsDto } from './dto/query-items.dto';
import { UpdateItemDto } from './dto/update-item.dto';
import { ItemsService } from './items.service';

function assertNonEmptyId(id: string): void {
  if (!id || id.trim().length === 0) {
    throw new BadRequestException('El parámetro "id" no puede estar vacío');
  }
}

/**
 * Catálogo de suministros y repuestos. Lectura para cualquier rol con sesión —
 * el mantenedor necesita consultar disponibilidad antes de pedir material. La
 * gestión de la ficha y el ajuste por conteo son de ADMIN (bodega).
 */
@Controller('inventory/items')
export class ItemsController {
  constructor(private readonly service: ItemsService) {}

  @Get()
  async findAll(@Query() filters: QueryItemsDto) {
    return { data: await this.service.findAll(filters), message: 'ok' };
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    assertNonEmptyId(id);
    return { data: await this.service.findOne(id), message: 'ok' };
  }

  @Get(':id/kardex')
  async kardex(@Param('id') id: string, @Query('branchId') branchId?: string) {
    assertNonEmptyId(id);
    return { data: await this.service.kardex(id, branchId), message: 'ok' };
  }

  @Post()
  @Roles([ROLES.ADMIN])
  async create(@Body() dto: CreateItemDto, @Session() session: UserSession) {
    return {
      data: await this.service.create(dto, session.user.id),
      message: 'Ítem creado',
    };
  }

  @Patch(':id')
  @Roles([ROLES.ADMIN])
  async update(@Param('id') id: string, @Body() dto: UpdateItemDto) {
    assertNonEmptyId(id);
    return {
      data: await this.service.update(id, dto),
      message: 'Ítem actualizado',
    };
  }

  @Post(':id/adjust')
  @Roles([ROLES.ADMIN])
  async adjust(
    @Param('id') id: string,
    @Body() dto: AdjustStockDto,
    @Session() session: UserSession,
  ) {
    assertNonEmptyId(id);
    const result = await this.service.adjust(id, dto, session.user.id);
    return {
      data: result,
      message: result.movement
        ? 'Existencia ajustada'
        : 'El conteo coincide con el sistema, no se registró movimiento',
    };
  }

  @Delete(':id')
  @Roles([ROLES.ADMIN])
  async remove(@Param('id') id: string) {
    assertNonEmptyId(id);
    await this.service.remove(id);
    return { data: { id }, message: 'Ítem eliminado' };
  }
}
