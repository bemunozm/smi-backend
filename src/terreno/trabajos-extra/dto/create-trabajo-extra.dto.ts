import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsNotEmpty,
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

  /**
   * Operador del catálogo propio (`Operator`) — OBLIGATORIO (RFC Supervisión
   * en Terreno, Anexo 2 "operador del catálogo en Trabajos extra + snapshot
   * único"). `operador` YA NO se recibe acá: el servicio lo arma desde
   * `OperatorsService.assertActive(operatorId).name`, nunca desde texto que
   * mande el cliente. Con `forbidNonWhitelisted: true` global, mandar
   * `operador` en el body ahora es un 400.
   */
  @IsString()
  @IsNotEmpty()
  operatorId!: string;

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
  @IsIn(ACTIVIDADES, { each: true })
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
