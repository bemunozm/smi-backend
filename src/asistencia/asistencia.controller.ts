import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../auth/roles';
import { AsistenciaService } from './asistencia.service';

@Controller('asistencia')
export class AsistenciaController {
  constructor(private readonly service: AsistenciaService) {}

  /** Grilla de asistencia del mes — datos de nómina: solo oficina. */
  @Get()
  @Roles([ROLES.ADMIN, ROLES.SECRETARIA])
  async mes(@Query('mes') mes?: string) {
    return { data: await this.service.mes(mes ?? ''), message: 'ok' };
  }
}
