import { Module } from '@nestjs/common';

import { ActivityLogController } from './activity-log.controller';
import { ActivityLogService } from './activity-log.service';

/**
 * Registro de actividad del administrador: lectura agregada de lo que se
 * registra en la plataforma (cargas, tarjetas, reportes, Reports, hallazgos,
 * mantenimiento) más el historial de cambios. Solo lecturas — las escrituras
 * siguen viviendo en cada dominio.
 */
@Module({
  controllers: [ActivityLogController],
  providers: [ActivityLogService],
})
export class ActivityLogModule {}
