import { Module } from '@nestjs/common';

import { StorageService } from './storage.service';

/**
 * NO es `@Global()` a propósito (ver Diseño del RFC, "Módulos"): cada
 * dominio que necesite `StorageService` (Files, Equipment, EquipmentDocument,
 * Combustible, Ficha) lo importa explícitamente. Mantiene visible el
 * acoplamiento a storage en cada `*.module.ts` en vez de esconderlo detrás
 * de un import global.
 */
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
