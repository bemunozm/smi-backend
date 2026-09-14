import { Module } from '@nestjs/common';

import { BranchController } from './branch.controller';
import { BranchService } from './branch.service';

@Module({
  controllers: [BranchController],
  providers: [BranchService],
  // Exportado para que Equipment (y, a futuro, Inventario) puedan inyectarlo
  // si necesitan validar/leer sucursales sin pasar por HTTP.
  exports: [BranchService],
})
export class BranchModule {}
