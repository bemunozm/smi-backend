import { Module } from '@nestjs/common';
import { OperatorsModule } from '../../operators/operators.module';
import { TrabajosExtraController } from './trabajos-extra.controller';
import { TrabajosExtraService } from './trabajos-extra.service';

@Module({
  imports: [OperatorsModule],
  controllers: [TrabajosExtraController],
  providers: [TrabajosExtraService],
})
export class TrabajosExtraModule {}
