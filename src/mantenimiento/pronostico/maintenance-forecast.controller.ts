import { Controller, Get, Param } from '@nestjs/common';
import { Roles } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../../auth/roles';
import { assertNonEmptyId } from '../common/assert-non-empty-id';
import { MaintenanceForecastService } from './maintenance-forecast.service';

/** Los mismos que leen la pauta: también el supervisor, que ve los equipos en faena. */
const LECTORES = [ROLES.ADMIN, ROLES.MANTENEDOR, ROLES.SUPERVISOR];

/**
 * Fecha estimada de la próxima mantención por uso promedio (solo lectura).
 * Pesados en horas máquina, livianos en km.
 */
@Controller('maintenance-forecast')
export class MaintenanceForecastController {
  constructor(private readonly service: MaintenanceForecastService) {}

  @Get()
  @Roles(LECTORES)
  async forAll() {
    return { data: await this.service.forAll(), message: 'ok' };
  }

  @Get(':equipmentId')
  @Roles(LECTORES)
  async forEquipment(@Param('equipmentId') equipmentId: string) {
    assertNonEmptyId(equipmentId);
    return {
      data: await this.service.forEquipment(equipmentId),
      message: 'ok',
    };
  }
}
