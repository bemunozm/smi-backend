import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../../auth/roles';
import { CurrentEditor } from '../../change-log/current-editor.decorator';
import type { Editor } from '../../change-log/change-log.service';
import { ReporteDiarioService } from './reporte-diario.service';
import { CreateReporteDiarioDto } from './dto/create-reporte-diario.dto';
import { UpdateReporteDiarioDto } from './dto/update-reporte-diario.dto';
import { FindReportesQueryDto } from './dto/find-reportes-query.dto';

@Controller('reporte-diario')
export class ReporteDiarioController {
  constructor(private readonly service: ReporteDiarioService) {}

  @Get()
  async findAll(@Query() query: FindReportesQueryDto) {
    return { data: await this.service.findAll(query), message: 'ok' };
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return { data: await this.service.findOne(id), message: 'ok' };
  }

  @Post()
  @Roles([ROLES.SUPERVISOR, ROLES.ADMIN])
  async create(
    @Body() dto: CreateReporteDiarioDto,
    @Session() session: UserSession,
  ) {
    return {
      data: await this.service.create(dto, session.user.id, session.user.name),
      message: 'Reporte enviado',
    };
  }

  /** Corrección post-envío. Quién edita sale de la sesión, nunca del body. */
  @Patch(':id')
  @Roles([ROLES.SUPERVISOR, ROLES.ADMIN])
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateReporteDiarioDto,
    @CurrentEditor() editor: Editor,
  ) {
    return {
      data: await this.service.update(id, dto, editor),
      message: 'Reporte corregido',
    };
  }

  /** Quién cambió qué y cuándo, del más reciente al más viejo. */
  @Get(':id/changes')
  async findChanges(@Param('id') id: string) {
    return { data: await this.service.findChanges(id), message: 'ok' };
  }
}
