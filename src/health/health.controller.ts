import { Controller, Get } from '@nestjs/common';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';

interface HealthResponse {
  data: { status: 'ok' };
  message: string;
}

@Controller('health')
export class HealthController {
  @Get()
  @AllowAnonymous()
  check(): HealthResponse {
    return { data: { status: 'ok' }, message: 'ok' };
  }
}
