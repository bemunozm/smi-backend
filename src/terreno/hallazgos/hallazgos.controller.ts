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
import { HallazgosService } from './hallazgos.service';
import { CreateHallazgoDto } from './dto/create-hallazgo.dto';
import { UpdateHallazgoDto } from './dto/update-hallazgo.dto';

@Controller('hallazgos')
export class HallazgosController {
  constructor(private readonly service: HallazgosService) {}

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
    @Body() dto: CreateHallazgoDto,
    @Session() session: UserSession,
  ) {
    // El usuario hace falta para reclamar la foto temporal: `claimTmp` valida
    // que la key subida le pertenezca antes de moverla a su lugar definitivo.
    return {
      data: await this.service.create(dto, session.user.id),
      message: 'Hallazgo registrado',
    };
  }

  /**
   * Corrección de un hallazgo ya registrado. Quién edita
   * sale de la sesión, nunca del body: es la firma del cambio en el registro.
   */
  @Patch(':id')
  @Roles([ROLES.SUPERVISOR, ROLES.ADMIN])
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateHallazgoDto,
    @CurrentEditor() editor: Editor,
    @ExpectedFields() expected?: ExpectedValues,
  ) {
    return {
      data: await this.service.update(id, dto, editor, expected),
      message: 'Hallazgo actualizado. Se avisó al administrador.',
    };
  }

  /** Quién cambió qué y cuándo, del cambio más reciente al más viejo. */
  @Get(':id/changes')
  async findChanges(@Param('id') id: string) {
    return { data: await this.service.findChanges(id), message: 'ok' };
  }
}
