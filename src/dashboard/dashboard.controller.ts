import { Controller, Get } from '@nestjs/common';
import { Roles } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../auth/roles';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
@Roles([ROLES.ADMIN])
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('hoy')
  async hoy() {
    return { data: await this.service.hoy(), message: 'ok' };
  }
}
