import { Module } from '@nestjs/common';
import { HorometroController } from './horometro.controller';
import { HorometroService } from './horometro.service';
import { OperatorsModule } from '../../operators/operators.module';

@Module({
  imports: [OperatorsModule],
  controllers: [HorometroController],
  providers: [HorometroService],
})
export class HorometroModule {}
