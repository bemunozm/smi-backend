import { Module } from '@nestjs/common';

import { EquipmentDocumentController } from './equipment-document.controller';
import { EquipmentDocumentService } from './equipment-document.service';

@Module({
  controllers: [EquipmentDocumentController],
  providers: [EquipmentDocumentService],
})
export class EquipmentDocumentModule {}
