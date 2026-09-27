import { Module } from '@nestjs/common';

import { StorageModule } from '../storage/storage.module';
import { EquipmentDocumentModule } from './documents/equipment-document.module';
import { EquipmentController } from './equipment.controller';
import { EquipmentService } from './equipment.service';

@Module({
  imports: [StorageModule, EquipmentDocumentModule],
  controllers: [EquipmentController],
  providers: [EquipmentService],
  // Exportado para que otros dominios (p. ej. el motor preventivo de
  // Mantenimiento, que actualiza `currentHourmeter`) puedan inyectarlo en vez
  // de escribir sobre la tabla `Equipment` por su cuenta.
  exports: [EquipmentService],
})
export class EquipmentModule {}
