import { Module } from '@nestjs/common';

import { StorageModule } from '../storage/storage.module';
import { FichaController } from './ficha.controller';
import { FichaService } from './ficha.service';

@Module({
  imports: [StorageModule],
  controllers: [FichaController],
  providers: [FichaService],
})
export class FichaModule {}
