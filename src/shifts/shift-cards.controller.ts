import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../auth/roles';
import { ExpectedFields } from '../common/concurrency/expected-fields.decorator';
import type { ExpectedValues } from '../common/concurrency/expected-fields';
import { CloseShiftCardDto } from './dto/close-shift-card.dto';
import { OpenShiftCardDto } from './dto/open-shift-card.dto';
import { UpdateShiftCardDto } from './dto/update-shift-card.dto';
import { ShiftsService } from './shifts.service';

/**
 * Tarjetas de turno de Supervisión en Terreno, Módulo A. Todo el módulo es
 * SUPERVISOR/ADMIN — no hay lectura
 * abierta a otros roles (a diferencia de, por ejemplo, `EquipmentController`)
 * porque una tarjeta expone datos operativos de turno, no un catálogo.
 */
@Controller('shift-cards')
@Roles([ROLES.SUPERVISOR, ROLES.ADMIN])
export class ShiftCardsController {
  constructor(private readonly service: ShiftsService) {}

  /**
   * Abre una tarjeta. `201` en el caso normal; también `201` en un reintento
   * (replay) — el body es idéntico a la primera vez, así que no vale la pena
   * la complejidad de devolver `200` solo en ese caso (el contrato acepta
   * cualquiera de los dos para el replay).
   */
  @Post()
  async open(
    @Body() dto: OpenShiftCardDto,
    @Session() session: UserSession,
    @Headers('x-client-time') clientTime?: string,
  ) {
    return {
      data: await this.service.openCard(dto, session, clientTime),
      message: 'Tarjeta abierta',
    };
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  async close(
    @Param('id') id: string,
    @Body() dto: CloseShiftCardDto,
    @Session() session: UserSession,
  ) {
    return {
      data: await this.service.closeCard(id, dto, session),
      message: 'Tarjeta cerrada',
    };
  }

  /**
   * Corrección de una tarjeta ya enviada. `X-Expected`
   * (opcional) lleva los valores que el cliente vio al editar; ver
   * `assertExpected`.
   */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateShiftCardDto,
    @Session() session: UserSession,
    @ExpectedFields() expected?: ExpectedValues,
  ) {
    return {
      data: await this.service.update(id, dto, session, expected),
      message: 'Tarjeta actualizada. Se avisó al administrador.',
    };
  }

  /** Quién cambió qué y cuándo, del cambio más reciente al más viejo. */
  @Get(':id/changes')
  async findChanges(@Param('id') id: string, @Session() session: UserSession) {
    return {
      data: await this.service.findChanges(id, session),
      message: 'ok',
    };
  }

  // Declarada como ruta ESTÁTICA ('mine') — no hay `GET :id` en este
  // controller con el que pueda chocar el orden de registro de Nest.
  @Get('mine')
  async mine(@Session() session: UserSession) {
    return { data: await this.service.mine(session), message: 'ok' };
  }
}
