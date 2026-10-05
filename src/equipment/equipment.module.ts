import { Module } from '@nestjs/common';

import { OperatorsModule } from '../operators/operators.module';
import { StorageModule } from '../storage/storage.module';
import { EquipmentDocumentModule } from './documents/equipment-document.module';
import { EquipmentController } from './equipment.controller';
import { EquipmentService } from './equipment.service';

@Module({
  // `OperatorsModule` (el operador ya no es usuario de la plataforma):
  // `EquipmentService.updateAssignment`
  // valida el operador con `OperatorsService.assertActive` en vez de
  // `assertUserWithRole` — no hay ciclo, `OperatorsModule` no importa Flota.
  imports: [StorageModule, EquipmentDocumentModule, OperatorsModule],
  controllers: [EquipmentController],
  providers: [EquipmentService],
  // Exportado para que otros dominios (p. ej. el motor preventivo de
  // Mantenimiento, que actualiza `currentHourmeter`) puedan inyectarlo en vez
  // de escribir sobre la tabla `Equipment` por su cuenta.
  exports: [EquipmentService],
})
export class EquipmentModule {}
