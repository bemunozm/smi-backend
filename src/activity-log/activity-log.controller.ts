import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../auth/roles';
import { ActivityLogService } from './activity-log.service';

@Controller('activity-log')
export class ActivityLogController {
  constructor(private readonly service: ActivityLogService) {}

  /** El registro de actividad de un rango de días — vista de oficina. */
  @Get()
  @Roles([ROLES.ADMIN, ROLES.SECRETARIA])
  async feed(@Query('from') from?: string, @Query('to') to?: string) {
    return { data: await this.service.feed(from, to), message: 'ok' };
  }
}
