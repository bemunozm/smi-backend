import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../../auth/roles';
import { CreateInformeTemporalDto } from './dto/create-informe-temporal.dto';
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
}
