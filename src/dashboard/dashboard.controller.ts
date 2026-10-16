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

  @Get('equipos')
  async equipos(@Query() q: DashboardRangeDto) {
    return { data: await this.service.equipos(q), message: 'ok' };
  }
}
