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
  asignadoA: AsignadoResponseDto | null;
  tareas: TareaResponseDto[];
  createdAt: string;
  updatedAt: string;
}
