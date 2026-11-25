import { Module } from '@nestjs/common';

import { ChangeLogModule } from '../../change-log/change-log.module';
import { ShiftsModule } from '../../shifts/shifts.module';
import { StorageModule } from '../../storage/storage.module';
import { InformesTemporalesController } from './informes-temporales.controller';
import { InformesTemporalesService } from './informes-temporales.service';

/** Informes del supervisor temporal. Importa `ShiftsModule` porque el
 * informe cierra las tarjetas con `ShiftsService.closeCard`. */
@Module({
  imports: [ShiftsModule, StorageModule, ChangeLogModule],
  controllers: [InformesTemporalesController],
  providers: [InformesTemporalesService],
})
export class InformesTemporalesModule {}
