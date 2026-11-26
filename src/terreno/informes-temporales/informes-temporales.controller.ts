import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../../auth/roles';
import { CreateInformeAntiguoDto } from './dto/create-informe-antiguo.dto';
import { CreateInformeTemporalDto } from './dto/create-informe-temporal.dto';
import { QueryNumeroLibreDto } from './dto/query-numero-libre.dto';
import { QueryInformesTemporalesDto } from './dto/query-informes-temporales.dto';
import { UpdateInformeTemporalDto } from './dto/update-informe-temporal.dto';
import { InformesTemporalesService } from './informes-temporales.service';

@Controller('informes-temporales')
export class InformesTemporalesController {
  constructor(private readonly service: InformesTemporalesService) {}

  /** Cierre agrupado: cierra las tarjetas del supervisor temporal y registra
   * el informe de su jornada. Quién lo envía sale de la sesión. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles([ROLES.SUPERVISOR_TEMPORAL])
  async create(
    @Body() dto: CreateInformeTemporalDto,
    @Session() session: UserSession,
  ) {
    return {
      data: await this.service.create(dto, session),
      message: 'Informe registrado',
    };
  }

  /**
   * «Subir informe antiguo»: un informe en papel sin tarjetas, con sus equipos
   * a mano. El supervisor temporal sube los suyos; la oficina elige de quién es.
   */
  @Post('antiguo')
  @HttpCode(HttpStatus.CREATED)
  @Roles([ROLES.SUPERVISOR_TEMPORAL, ROLES.ADMIN, ROLES.SECRETARIA])
  async createAntiguo(
    @Body() dto: CreateInformeAntiguoDto,
    @Session() session: UserSession,
  ) {
    return {
      data: await this.service.createAntiguo(dto, session),
      message: 'Informe registrado',
    };
  }

  /** ¿El N° está libre? Para avisar en el formulario del informe antiguo.
   * Va ANTES de `:id` para que `numero-libre` no se lea como un id. */
  @Get('numero-libre')
  @Roles([ROLES.SUPERVISOR_TEMPORAL, ROLES.ADMIN, ROLES.SECRETARIA])
  async numeroLibre(@Query() query: QueryNumeroLibreDto) {
    return {
      data: await this.service.numeroLibre(query.numero),
      message: 'ok',
    };
  }

  @Get()
  @Roles([ROLES.ADMIN, ROLES.SECRETARIA])
  async findAll(@Query() query: QueryInformesTemporalesDto) {
    return { data: await this.service.findAll(query), message: 'ok' };
  }

  /** «Mis reportes»: los informes que envió el supervisor de la sesión.
   * Va ANTES de `:id` para que `mine` no se lea como un id. */
  @Get('mine')
  @Roles([ROLES.SUPERVISOR_TEMPORAL])
  async findMine(@Session() session: UserSession) {
    return { data: await this.service.findMine(session), message: 'ok' };
  }

  /** El supervisor temporal solo ve el suyo (lo valida el servicio). */
  @Get(':id')
  @Roles([ROLES.ADMIN, ROLES.SECRETARIA, ROLES.SUPERVISOR_TEMPORAL])
  async findOne(@Param('id') id: string, @Session() session: UserSession) {
    return { data: await this.service.findOne(id, session), message: 'ok' };
  }

  @Patch(':id')
  @Roles([ROLES.ADMIN, ROLES.SECRETARIA])
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateInformeTemporalDto,
    @Session() session: UserSession,
  ) {
    return {
      data: await this.service.update(id, dto, session),
      message: 'Informe actualizado',
    };
  }

  @Get(':id/changes')
  @Roles([ROLES.ADMIN, ROLES.SECRETARIA])
  async findChanges(@Param('id') id: string) {
    return { data: await this.service.findChanges(id), message: 'ok' };
  }

  /** Borra el informe y sus tarjetas. */
  @Delete(':id')
  @Roles([ROLES.ADMIN])
  async remove(@Param('id') id: string, @Session() session: UserSession) {
    await this.service.remove(id, session);
    return { data: null, message: 'Informe eliminado' };
  }
}
