import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export const ACTIVIDADES = [
  'REGULACION_CARGA',
  'LIMPIEZA_CANCHA',
  'SOLTAR_MATERIAL',
  'LIMPIEZA_SILOS',
  'HACER_PETRIL',
  'ARREGLO_CANCHA',
  // Válvula de escape para la tarea que no estaba en la lista. Viaja junto a
  // `otraActividad`, que es donde va el texto.
  'OTRO',
] as const;

export class CreateTrabajoExtraDto {
  @IsString()
  equipoId!: string;

  @IsString()
  operador!: string;

  @IsString()
  faena!: string;

  @IsIn(['DIURNO', 'NOCTURNO'])
  turno!: string;

  @IsNumber()
  horometroInicial!: number;

  @IsNumber()
  horometroFinal!: number;

  /**
   * Una salida suele mezclar tareas, así que van varias. Al menos una: un
   * trabajo extraordinario sin actividad no se puede cobrar ni justificar.
   */
  @IsArray()
  @ArrayNotEmpty({ message: 'Elegí al menos una actividad' })
  @IsIn(ACTIVIDADES as unknown as string[], { each: true })
  actividades!: string[];

  /**
   * Texto libre para la tarea que no estaba en la lista. El servicio exige que
   * venga cuando se eligió `OTRO`, y lo ignora cuando no.
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  otraActividad?: string;

  @IsString()
  descripcion!: string;

  @IsOptional()
  @IsString()
  observaciones?: string;
}
