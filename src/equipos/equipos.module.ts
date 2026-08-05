import { Module } from '@nestjs/common';

import { EquiposController } from './equipos.controller';
import { EquiposService } from './equipos.service';

@Module({
  controllers: [EquiposController],
  providers: [EquiposService],
  // Exportado para que otros dominios (p. ej. el motor preventivo de
  // Mantenimiento, que actualiza `horometroActual`) puedan inyectarlo en vez
  // de escribir sobre la tabla `Equipo` por su cuenta.
  exports: [EquiposService],
})
export class EquiposModule {}
