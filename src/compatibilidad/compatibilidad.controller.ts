import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../auth/roles';
import { CompatibilidadService } from './compatibilidad.service';
import { CreateCompatibilidadDto } from './dto/create-compatibilidad.dto';
import { QueryRepuestosDto } from './dto/query-repuestos.dto';
import { ReplicarCompatibilidadesDto } from './dto/replicar-compatibilidades.dto';
import { UpdateCompatibilidadDto } from './dto/update-compatibilidad.dto';

function assertNonEmptyId(id: string, nombre = 'id'): void {
  if (!id || id.trim().length === 0) {
    throw new BadRequestException(
      `El parámetro "${nombre}" no puede estar vacío`,
    );
  }
}

/**
 * Alta y baja de compatibilidades (RFC-12).
 *
 * **MANTENEDOR puede escribir**, no solo ADMIN: quien descubre que un repuesto
 * calza es el mecánico con la máquina abierta al frente. Obligarlo a pedirle a
 * un administrador que lo registre es la vía más rápida a que el dato no se
 * registre nunca — que es exactamente el problema que este módulo resuelve.
 */
@Controller('compatibilidades')
export class CompatibilidadController {
  constructor(private readonly service: CompatibilidadService) {}

  @Post()
  @Roles([ROLES.ADMIN, ROLES.MANTENEDOR])
  async create(
    @Body() dto: CreateCompatibilidadDto,
    @Session() session: UserSession,
  ) {
    return {
      data: await this.service.create(dto, session.user.id),
      message: 'Compatibilidad declarada',
    };
  }

  @Patch(':id')
  @Roles([ROLES.ADMIN, ROLES.MANTENEDOR])
  async update(@Param('id') id: string, @Body() dto: UpdateCompatibilidadDto) {
    assertNonEmptyId(id);
    return {
      data: await this.service.update(id, dto),
      message: 'Nota actualizada',
    };
  }

  @Delete(':id')
  @Roles([ROLES.ADMIN, ROLES.MANTENEDOR])
  async remove(@Param('id') id: string) {
    assertNonEmptyId(id);
    await this.service.remove(id);
    return { data: { id }, message: 'Compatibilidad eliminada' };
  }
}

/**
 * Repuestos compatibles con un equipo — la consulta del ticket PROD-12.
 *
 * Cuelga de `/api/equipos/:equipoId/repuestos` **sin editar
 * `equipos.controller.ts`**: Express resuelve ambas rutas sin ambigüedad porque
 * `/equipos/:id` nunca captura una ruta de tres segmentos. Así la funcionalidad
 * aparece donde el cliente la espera (dentro del equipo) y el archivo del
 * dominio de Flota no se toca.
 */
@Controller('equipos/:equipoId/repuestos')
export class RepuestosEquipoController {
  constructor(private readonly service: CompatibilidadService) {}

  @Get()
  async findAll(
    @Param('equipoId') equipoId: string,
    @Query() filtros: QueryRepuestosDto,
  ) {
    assertNonEmptyId(equipoId, 'equipoId');
    return {
      data: await this.service.repuestosDeEquipo(equipoId, filtros),
      message: 'ok',
    };
  }

  // Rutas hermanas estáticas: no chocan con `@Get()` porque tienen un segmento
  // más. Si alguna vez se agrega un `@Get(':compatibilidadId')` a este
  // controller, tiene que ir DESPUÉS de éstas o capturará "replicables".
  @Get('replicables')
  async replicables(@Param('equipoId') equipoId: string) {
    assertNonEmptyId(equipoId, 'equipoId');
    return {
      data: await this.service.origenesReplicables(equipoId),
      message: 'ok',
    };
  }

  @Post('replicar')
  @Roles([ROLES.ADMIN, ROLES.MANTENEDOR])
  async replicar(
    @Param('equipoId') equipoId: string,
    @Body() dto: ReplicarCompatibilidadesDto,
    @Session() session: UserSession,
  ) {
    assertNonEmptyId(equipoId, 'equipoId');
    const resultado = await this.service.replicar(
      equipoId,
      dto,
      session.user.id,
    );
    return {
      data: resultado,
      message:
        resultado.omitidas > 0
          ? `${resultado.copiadas} repuesto(s) copiados; ${resultado.omitidas} ya estaban declarados`
          : `${resultado.copiadas} repuesto(s) copiados`,
    };
  }
}

/**
 * Dirección inversa: en qué equipos se usa un repuesto. Es la pregunta de
 * bodega — si un repuesto no sirve para ninguna máquina de la flota, reponerlo
 * es plata detenida.
 *
 * Comparte prefijo con `InsumosController` sin colisionar: esta ruta tiene un
 * segmento más.
 */
@Controller('inventario/insumos')
export class EquiposDeInsumoController {
  constructor(private readonly service: CompatibilidadService) {}

  @Get(':id/equipos')
  async findAll(@Param('id') id: string) {
    assertNonEmptyId(id);
    return { data: await this.service.equiposDeInsumo(id), message: 'ok' };
  }
}
