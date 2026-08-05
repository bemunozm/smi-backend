import type { TipoOT } from '@prisma/client';

export interface IntervencionInsumoResponseDto {
  id: string;
  insumoId: string;
  cantidad: number;
}

export interface IntervencionResponseDto {
  id: string;
  ordenId: string;
  tipo: TipoOT;
  detalle: string;
  horasHombre: number;
  horometro: number | null;
  soloLectura: boolean;
  insumos: IntervencionInsumoResponseDto[];
  fecha: string;
}
