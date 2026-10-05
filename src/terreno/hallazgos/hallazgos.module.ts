import { Module } from '@nestjs/common';

import { ChangeLogModule } from '../../change-log/change-log.module';
import { StorageModule } from '../../storage/storage.module';
import { HallazgosController } from './hallazgos.controller';
import { HallazgosService } from './hallazgos.service';

@Module({
  imports: [StorageModule, ChangeLogModule],
  controllers: [HallazgosController],
  providers: [HallazgosService],
})
export class HallazgosModule {}
