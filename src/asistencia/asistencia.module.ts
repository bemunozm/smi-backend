import { Module } from '@nestjs/common';

import { AsistenciaController } from './asistencia.controller';
import { AsistenciaService } from './asistencia.service';

/** `PrismaService` llega del `PrismaModule` global — igual que los vecinos. */
@Module({
  controllers: [AsistenciaController],
  providers: [AsistenciaService],
})
export class AsistenciaModule {}
