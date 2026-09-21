import { IsIn, IsOptional } from 'class-validator';

import { ALL_ROLES } from '../../auth/roles';
import type { Role } from '../../auth/roles';

/**
 * Filtros de `GET /api/users`. Con `whitelist + forbidNonWhitelisted`
 * activos globalmente (ver `equipment/dto/query-equipment.dto.ts`), todo
 * filtro nuevo se declara acá explícitamente.
 *
 * `role` alimenta los pickers de operador/supervisor de la asignación de
 * Flota (`PATCH /api/equipment/:id/assignment`) — reusa `UsersService.findByRole`,
 * ya existente para el fan-out de notificaciones por rol.
 */
export class QueryUsersDto {
  @IsOptional()
  @IsIn(ALL_ROLES)
  role?: Role;
}
