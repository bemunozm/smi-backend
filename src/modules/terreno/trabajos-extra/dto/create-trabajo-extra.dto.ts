import { IsIn, IsNumber, IsOptional, IsString } from 'class-validator';

export const ACTIVIDADES = [
  'REGULACION_CARGA',
  'LIMPIEZA_CANCHA',
  'SOLTAR_MATERIAL',
  'LIMPIEZA_SILOS',
  'HACER_PETRIL',
  'ARREGLO_CANCHA',
] as const;

export class CreateTrabajoExtraDto {
  @IsString()
  equipoId: string;

  @IsString()
  operador: string;

  @IsString()
  faena: string;

  @IsIn(['DIURNO', 'NOCTURNO'])
  turno: string;

  @IsNumber()
  horometroInicial: number;

  @IsNumber()
  horometroFinal: number;

  @IsIn(ACTIVIDADES as unknown as string[])
  actividad: string;

  @IsString()
  descripcion: string;

  @IsOptional()
  @IsString()
  observaciones?: string;
}
