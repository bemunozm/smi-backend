import { Module } from '@nestjs/common';

import { OperatorsController } from './operators.controller';
import { OperatorsService } from './operators.service';

@Module({
  controllers: [OperatorsController],
  providers: [OperatorsService],
  // Exportado para que Terreno (Fase 2, `src/shifts/*`) pueda inyectarlo si
  // necesita validar/leer operadores sin pasar por HTTP.
  exports: [OperatorsService],
})
export class OperatorsModule {}
