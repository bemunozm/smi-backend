import { Module } from '@nestjs/common';

import { ChangeLogModule } from '../../change-log/change-log.module';
import { TrabajosExtraController } from './trabajos-extra.controller';
import { TrabajosExtraService } from './trabajos-extra.service';

@Module({
  imports: [ChangeLogModule],
  controllers: [TrabajosExtraController],
  providers: [TrabajosExtraService],
})
export class TrabajosExtraModule {}
