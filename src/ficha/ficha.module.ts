import { Module } from '@nestjs/common';

import { FichaController } from './ficha.controller';
import { FichaService } from './ficha.service';

@Module({
  controllers: [FichaController],
  providers: [FichaService],
})
export class FichaModule {}
