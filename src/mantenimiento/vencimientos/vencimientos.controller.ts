import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../../auth/roles';
import { VencimientosService } from './vencimientos.service';

/**
 * Módulo 4 · R21: el calendario anual de vencimientos de los vehículos
 * livianos. Lo ven el mantenedor y el administrador, que son los que reciben
 * los avisos.
 */
@Controller('vencimientos')
export class VencimientosController {
  constructor(private readonly service: VencimientosService) {}

  /**
   * 12 meses por patente desde `?desde=YYYY-MM` (por defecto, el mes actual).
   * Con `?equipmentId=`, solo ese liviano: es la tarjeta de su ficha.
   */
  @Get('calendario')
  @Roles([ROLES.MANTENEDOR, ROLES.ADMIN])
  async calendar(
    @Query('desde') desde?: string,
    @Query('equipmentId') equipmentId?: string,
  ) {
    return {
      data: await this.service.calendar(desde, new Date(), equipmentId),
      message: 'ok',
    };
  }
}
