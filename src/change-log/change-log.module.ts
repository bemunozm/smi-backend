import { Module } from '@nestjs/common';

import { ChangeLogService } from './change-log.service';

/**
 * Trazabilidad de cambios (Acta N.° 004, R13). No es `@Global`: cada dominio
 * que edite registros enviados lo importa explícito, igual que `StorageModule`.
 */
@Module({
  providers: [ChangeLogService],
  exports: [ChangeLogService],
})
export class ChangeLogModule {}
