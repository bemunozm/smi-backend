import type { EstadoOT, OrigenOT, PrioridadOT, TipoOT } from '@prisma/client';

import type { AsignadoResponseDto } from './asignado-response.dto';
import type { TareaResponseDto } from './tarea-response.dto';

export interface OrdenResponseDto {
  id: string;
  equipoId: string;
  titulo: string;
  estado: EstadoOT;
  prioridad: PrioridadOT;
  tipo: TipoOT;
  origen: OrigenOT;
  origenDetalle: string | null;
  /** Hallazgo de Terreno que originó la operación, si aplica. */
  hallazgoId: string | null;
  /** Hito y vuelta de la pauta que la originó (solo PREVENTIVAS de `checkAlert`). */
  pautaMilestone: number | null;
  pautaCycle: number | null;
  asignadoA: AsignadoResponseDto | null;
  tareas: TareaResponseDto[];
  createdAt: string;
  updatedAt: string;
}
