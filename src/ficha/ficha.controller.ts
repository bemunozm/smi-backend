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
 * equipo en el día a día — los 3 roles de plataforma (ADMIN, SUPERVISOR,
 * MANTENEDOR). El operador no entra en este chequeo porque ya no es un rol
 * de usuario: es un catálogo propio (`Operator`, `src/operators/*`) sin
 * acceso a la plataforma (RFC Supervisión en Terreno, anexo "el operador
 * deja de ser usuario de la plataforma", 28/09).
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
