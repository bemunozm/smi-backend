import { Module } from '@nestjs/common';

import { ChangeLogModule } from '../../change-log/change-log.module';
import { StorageModule } from '../../storage/storage.module';
import { CombustibleController } from './combustible.controller';
import { CombustibleService } from './combustible.service';

@Module({
  imports: [StorageModule, ChangeLogModule],
  controllers: [CombustibleController],
  providers: [CombustibleService],
})
export class CombustibleModule {}
