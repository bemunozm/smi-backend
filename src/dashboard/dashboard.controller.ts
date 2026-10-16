import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../auth/roles';
import { DashboardService } from './dashboard.service';
import { DashboardRangeDto } from './dto/dashboard-range.dto';

@Controller('dashboard')
@Roles([ROLES.ADMIN])
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('hoy')
  async hoy() {
    return { data: await this.service.hoy(), message: 'ok' };
  }

  @Get('resumen-dia')
  async resumenDia() {
    return { data: await this.service.resumenDia(), message: 'ok' };
  }

  @Get('equipos')
  async equipos(@Query() q: DashboardRangeDto) {
    return { data: await this.service.equipos(q), message: 'ok' };
  }

  @Get('supervisores')
  async supervisores(@Query() q: DashboardRangeDto) {
    return { data: await this.service.supervisores(q), message: 'ok' };
  }

  @Get('mantenedores')
  async mantenedores(@Query() q: DashboardRangeDto) {
    return { data: await this.service.mantenedores(q), message: 'ok' };
  }

  @Get('vueltas')
  async vueltas(@Query() q: DashboardRangeDto) {
    return { data: await this.service.vueltas(q), message: 'ok' };
  }
}
