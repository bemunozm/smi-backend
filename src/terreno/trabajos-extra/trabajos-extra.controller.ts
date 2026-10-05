import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../../auth/roles';
import { CurrentEditor } from '../../change-log/current-editor.decorator';
import type { Editor } from '../../change-log/change-log.service';
import { ExpectedFields } from '../../common/concurrency/expected-fields.decorator';
import type { ExpectedValues } from '../../common/concurrency/expected-fields';
import { TrabajosExtraService } from './trabajos-extra.service';
import { CreateTrabajoExtraDto } from './dto/create-trabajo-extra.dto';
import { UpdateTrabajoExtraDto } from './dto/update-trabajo-extra.dto';

@Controller('trabajos-extra')
export class TrabajosExtraController {
  constructor(private readonly service: TrabajosExtraService) {}

  @Get()
  async findAll() {
    return { data: await this.service.findAll(), message: 'ok' };
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return { data: await this.service.findOne(id), message: 'ok' };
  }

  @Post()
  @Roles([ROLES.SUPERVISOR, ROLES.ADMIN])
  async create(
    @Body() dto: CreateTrabajoExtraDto,
    @Session() session: UserSession,
  ) {
    return {
      data: await this.service.create(dto, session.user.id),
      message: 'Trabajo registrado',
    };
  }

  /**
   * Edición de un trabajo ya registrado. Quién edita sale
   * de la sesión, nunca del body: es la firma del cambio en el registro.
   */
  @Patch(':id')
  @Roles([ROLES.SUPERVISOR, ROLES.ADMIN])
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateTrabajoExtraDto,
    @CurrentEditor() editor: Editor,
    @ExpectedFields() expected?: ExpectedValues,
  ) {
    return {
      data: await this.service.update(id, dto, editor, expected),
      message: 'Trabajo actualizado. Se avisó al administrador.',
    };
  }

  /** Quién cambió qué y cuándo, del cambio más reciente al más viejo. */
  @Get(':id/changes')
  async findChanges(@Param('id') id: string) {
    return { data: await this.service.findChanges(id), message: 'ok' };
  }
}
