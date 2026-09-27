import { Module } from '@nestjs/common';

import { StorageModule } from '../../storage/storage.module';
import { CombustibleController } from './combustible.controller';
import { CombustibleService } from './combustible.service';

@Module({
  imports: [StorageModule],
  controllers: [CombustibleController],
  providers: [CombustibleService],
})
export class CombustibleModule {}
