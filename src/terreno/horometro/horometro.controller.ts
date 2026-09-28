import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../../auth/roles';
import { HorometroService } from './horometro.service';
import { CreateHorometroDto } from './dto/create-horometro.dto';
import { SalidaHorometroDto } from './dto/salida-horometro.dto';

@Controller('horometro')
export class HorometroController {
  constructor(private readonly service: HorometroService) {}

  @Get()
  async findAll() {
    return { data: await this.service.findAll(), message: 'ok' };
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return { data: await this.service.findOne(id), message: 'ok' };
  }

  @Post()
  @Roles([ROLES.SUPERVISOR, ROLES.ADMIN])
  async create(
    @Body() dto: CreateHorometroDto,
    @Session() session: UserSession,
  ) {
    return {
      data: await this.service.create(dto, session),
      message: 'Lectura registrada',
    };
  }

  // `PATCH /horometro/:id` genérico (`update`) se ELIMINÓ (RFC Supervisión
  // en Terreno, Fase 2): no validaba nada — podía cerrar una tarjeta en
  // silencio (`valorFinal` sin pasar por `salida()`) sin cuadrar el contador
  // del equipo ni respetar el gate de `shiftId`. Ningún uso en el frontend
  // (grep de `PATCH .../horometro/:id` y `updateHorometro` en
  // `smi-frontend/src`, confirmado antes de retirarlo).

  @Patch(':id/salida')
  @Roles([ROLES.SUPERVISOR, ROLES.ADMIN])
  async salida(
    @Param('id') id: string,
    @Body() dto: SalidaHorometroDto,
    @Session() session: UserSession,
  ) {
    return {
      data: await this.service.salida(id, dto, session),
      message: 'Turno cerrado',
    };
  }
}
