import { Module } from '@nestjs/common';

import { StorageModule } from '../../storage/storage.module';
import { HallazgosController } from './hallazgos.controller';
import { HallazgosService } from './hallazgos.service';

@Module({
  imports: [StorageModule], controllers: [HallazgosController], providers: [HallazgosService] })
export class HallazgosModule {}
