import { Module } from '@nestjs/common';

import { ChangeLogModule } from '../../change-log/change-log.module';
import { InventoryModule } from '../../inventory/inventory.module';
import { StorageModule } from '../../storage/storage.module';
import { CombustibleController } from './combustible.controller';
import { CombustibleService } from './combustible.service';

@Module({
  // `InventoryModule` por `AdBlueStockService`: el AdBlue de una carga manual
  // descuenta el ítem AdBlue del inventario.
  imports: [StorageModule, ChangeLogModule, InventoryModule],
  controllers: [CombustibleController],
  providers: [CombustibleService],
})
export class CombustibleModule {}
