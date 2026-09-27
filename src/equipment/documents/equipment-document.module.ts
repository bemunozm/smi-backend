import { Module } from '@nestjs/common';

import { StorageModule } from '../../storage/storage.module';
import { EquipmentDocumentController } from './equipment-document.controller';
import { EquipmentDocumentService } from './equipment-document.service';

@Module({
  imports: [StorageModule],
  controllers: [EquipmentDocumentController],
  providers: [EquipmentDocumentService],
})
export class EquipmentDocumentModule {}
