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

import { ROLES } from '../auth/roles';
import { OperatorsService } from './operators.service';
import { CreateOperatorDto } from './dto/create-operator.dto';
import { QueryOperatorDto } from './dto/query-operator.dto';
import { UpdateOperatorDto } from './dto/update-operator.dto';

function assertNonEmptyId(id: string): void {
  if (!id || id.trim().length === 0) {
    throw new BadRequestException('El parámetro "id" no puede estar vacío');
  }
}

/**
 * Catálogo propio de operadores (RFC Supervisión en Terreno, Fase 1 —
 * reemplaza el arreglo `OPERADORES` hardcodeado del frontend). Clon de
 * `BranchController`: la LECTURA queda abierta a cualquier sesión (la usa el
 * selector del Módulo A y, a futuro, el de Flota); la ESCRITURA es
 * ADMIN/SUPERVISOR; el BORRADO es solo ADMIN y queda guardado por uso en el
 * service.
 */
@Controller('operators')
export class OperatorsController {
  constructor(private readonly service: OperatorsService) {}

  @Get()
  async findAll(
    @Query() filtros: QueryOperatorDto,
    @Session() session: UserSession,
  ) {
    return {
      data: await this.service.findAll(filtros, session),
      message: 'ok',
    };
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @Session() session: UserSession) {
    assertNonEmptyId(id);
    return { data: await this.service.findOne(id, session), message: 'ok' };
  }

  @Post()
  @Roles([ROLES.ADMIN, ROLES.SUPERVISOR])
  async create(@Body() dto: CreateOperatorDto) {
    return {
      data: await this.service.create(dto),
      message: 'Operador creado',
    };
  }

  @Patch(':id')
  @Roles([ROLES.ADMIN, ROLES.SUPERVISOR])
  async update(@Param('id') id: string, @Body() dto: UpdateOperatorDto) {
    assertNonEmptyId(id);
    return {
      data: await this.service.update(id, dto),
      message: 'Operador actualizado',
    };
  }

  @Delete(':id')
  @Roles([ROLES.ADMIN])
  async remove(@Param('id') id: string) {
    assertNonEmptyId(id);
    await this.service.remove(id);
    return { data: { id }, message: 'Operador eliminado' };
  }
}
