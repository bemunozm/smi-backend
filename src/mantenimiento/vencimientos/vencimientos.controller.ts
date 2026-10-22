import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../../auth/roles';
import { SaveLightConfigDto } from './dto/save-light-config.dto';
import { VencimientosService } from './vencimientos.service';

/**
 * Módulo 4 · R21: el calendario anual de vencimientos de los vehículos
 * livianos y su «Asignar mantenciones». Lo ven el mantenedor y el
 * administrador, que son los que reciben los avisos.
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

  /**
   * La configuración de mantención y avisos de un liviano. La lee también el
   * supervisor, igual que la pauta de los pesados (en solo lectura).
   */
  @Get('livianos/:equipmentId')
  @Roles([ROLES.MANTENEDOR, ROLES.ADMIN, ROLES.SUPERVISOR])
  async lightConfig(@Param('equipmentId') equipmentId: string) {
    return {
      data: await this.service.lightConfig(equipmentId),
      message: 'ok',
    };
  }

  /** Guarda la configuración (los mismos que pueden guardar la pauta). */
  @Put('livianos/:equipmentId')
  @Roles([ROLES.MANTENEDOR, ROLES.ADMIN])
  async saveLightConfig(
    @Param('equipmentId') equipmentId: string,
    @Body() dto: SaveLightConfigDto,
    @Session() session: UserSession,
  ) {
    const editor = {
      id: session.user.id,
      name: session.user.name?.trim() || session.user.email,
    };
    return {
      data: await this.service.saveLightConfig(equipmentId, dto, editor),
      message: 'Mantención del liviano guardada',
    };
  }
}
