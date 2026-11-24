import type { IntervencionResponseDto } from './intervencion-response.dto';
import type { OrdenResponseDto } from './orden-response.dto';

/** Resultado de `POST /mantenimiento/ordenes/:id/finalizar`. */
export interface OrdenFinalizadaResponseDto {
  orden: OrdenResponseDto;
  intervencion: IntervencionResponseDto;
}
