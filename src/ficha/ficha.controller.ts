import { BadRequestException, Controller, Get, Param } from '@nestjs/common';
import { Roles } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../auth/roles';
import { FichaService } from './ficha.service';

function assertNonEmptyId(id: string): void {
  if (!id || id.trim().length === 0) {
    throw new BadRequestException('El parámetro "id" no puede estar vacío');
  }
}

/**
 * Ficha consolidada de un equipo (requerimientos §5.5, Núcleo). Cruza los
 * dominios de Flota, Terreno, Mantenimiento e Inventario en una sola línea de
 * tiempo. Solo lectura, por eso comparte roles con quienes operan sobre un
 * equipo en el día a día — OPERADOR queda fuera porque la ficha expone
 * historial completo (hallazgos, órdenes, intervenciones), no solo lo propio.
 */
@Controller('equipos')
export class FichaController {
  constructor(private readonly service: FichaService) {}

  @Get(':id/ficha')
  @Roles([ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.MANTENEDOR])
  async getFicha(@Param('id') id: string) {
    assertNonEmptyId(id);
    return { data: await this.service.getFichaEquipo(id), message: 'ok' };
  }
}
