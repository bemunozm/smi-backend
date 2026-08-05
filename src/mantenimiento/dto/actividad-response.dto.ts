import type { EstadoActividad, OrigenActividad } from '@prisma/client';

import type { AsignadoResponseDto } from './asignado-response.dto';

export interface ActividadResponseDto {
  id: string;
  descripcion: string;
  origen: OrigenActividad;
  referencia: string | null;
  asignadoA: AsignadoResponseDto | null;
  equipoId: string | null;
  hallazgoId: string | null;
  estado: EstadoActividad;
  createdAt: string;
  updatedAt: string;
}
