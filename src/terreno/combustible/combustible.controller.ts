import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../../auth/roles';
import { CurrentEditor } from '../../change-log/current-editor.decorator';
import type { Editor } from '../../change-log/change-log.service';
import { CombustibleService } from './combustible.service';
import { CreateCombustibleDto } from './dto/create-combustible.dto';
import { UpdateCombustibleDto } from './dto/update-combustible.dto';

@Controller('combustible')
export class CombustibleController {
  constructor(private readonly service: CombustibleService) {}

  @Get()
  async findAll() {
    return { data: await this.service.findAll(), message: 'ok' };
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return { data: await this.service.findOne(id), message: 'ok' };
  }

  @Post()
  // SECRETARIA registra la carga que un supervisor olvidó — mismo criterio
  // que el POST de trabajos-extra y hallazgos.
  @Roles([ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.SECRETARIA])
  async create(
    @Body() dto: CreateCombustibleDto,
    @Session() session: UserSession,
  ) {
    return {
      data: await this.service.create(dto, session.user.id),
      message: 'Carga registrada',
    };
  }

  // Corrección de datos registrados: un acto de administración, no de
  // operación — por eso más angosto que el resto del controller. Quién
  // corrige sale de la sesión: es la firma del cambio en el historial.
  @Patch(':id')
  @Roles([ROLES.ADMIN])
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateCombustibleDto,
    @CurrentEditor() editor: Editor,
  ) {
    return {
      data: await this.service.update(id, dto, editor),
      message: 'Carga actualizada',
    };
  }
}
