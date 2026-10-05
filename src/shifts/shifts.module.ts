import { Module } from '@nestjs/common';

import { OperatorsModule } from '../operators/operators.module';
import { StorageModule } from '../storage/storage.module';
import { ShiftCardsController } from './shift-cards.controller';
import { ShiftReportsController } from './shift-reports.controller';
import { ShiftReportsService } from './shift-reports.service';
import { ShiftsController } from './shifts.controller';
import { ShiftsService } from './shifts.service';

/**
 * Supervisión en Terreno, Módulo A (RFC Supervisión en Terreno, Fases 2-3).
 * Módulo nuevo y propio — NO vive dentro de `TerrenoModule` (Alexander):
 * reutiliza `RegistroHorometro` como tabla, pero es un dominio/flujo aparte
 * (abrir/cerrar en dos pasos con idempotencia por id de cliente), igual que
 * Flota (`HorometroModule`) también escribe sobre esa misma tabla sin vivir
 * en el mismo módulo. `ShiftReportsService` (reporte de salida) vive
 * en el mismo módulo que `ShiftsService` — comparten dominio y `Shift` como
 * llave natural — pero son servicios separados: el reporte no toca tarjetas.
 */
@Module({
  imports: [StorageModule, OperatorsModule],
  controllers: [ShiftCardsController, ShiftsController, ShiftReportsController],
  providers: [ShiftsService, ShiftReportsService],
  // `ShiftReportsService` se exporta para que `NotificationsModule` marque
  // `emailStatus` y lea el adjunto del PDF sin conocer `PrismaService` ni
  // `StorageService` — Shifts es dueño de `ShiftExitReport`, Notifications
  // solo orquesta. Ningún módulo de Shifts importa `NotificationsModule`
  // (evita el ciclo).
  exports: [ShiftReportsService],
})
export class ShiftsModule {}
