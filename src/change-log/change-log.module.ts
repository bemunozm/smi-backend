import { Module } from '@nestjs/common';

import { ChangeLogService } from './change-log.service';

/**
 * Trazabilidad de cambios. No es `@Global`: cada dominio
 * que edite registros enviados lo importa explícito, igual que `StorageModule`.
 */
@Module({
  providers: [ChangeLogService],
  exports: [ChangeLogService],
})
export class ChangeLogModule {}
