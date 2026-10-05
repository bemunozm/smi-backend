import { Transform } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { normalizeObservaciones } from '../../../common/normalize-observaciones';
import { SHIFT_TYPES, type ShiftType } from '../../../shifts/shift-type';

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

/**
 * Cómo se lee cada actividad en el registro de cambios y en el aviso al
 * administrador. Repite las etiquetas de la pantalla (`types/trabajosExtra.ts`
 * en el frontend): un aviso que dijera `HACER_PETRIL` no lo entiende nadie.
 */
export const ACTIVIDAD_LABEL: Record<string, string> = {
  REGULACION_CARGA: 'Regulación y carga',
  LIMPIEZA_CANCHA: 'Limpieza de cancha',
  SOLTAR_MATERIAL: 'Soltar material',
  LIMPIEZA_SILOS: 'Limpieza de silos',
  HACER_PETRIL: 'Hacer pretil',
  ARREGLO_CANCHA: 'Arreglo cancha',
  OTRO: 'Otro',
};

export class CreateTrabajoExtraDto {
  @IsString()
  equipoId!: string;

  /**
   * Operador del catálogo propio (`Operator`) — OBLIGATORIO (RFC Supervisión
   * en Terreno). `operador` YA NO se recibe acá: el servicio lo arma desde
   * `OperatorsService.assertActive(operatorId).name`, nunca desde texto que
   * mande el cliente. Con `forbidNonWhitelisted: true` global, mandar
   * `operador` en el body ahora es un 400.
   */
  @IsString()
  @IsNotEmpty()
  operatorId!: string;

  @IsString()
  @MaxLength(100)
  faena!: string;

  @IsIn(SHIFT_TYPES)
  turno!: ShiftType;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1_000_000)
  horometroInicial!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1_000_000)
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
  @MaxLength(1000)
  descripcion!: string;

  /** Mismo normalizado + tope que `CloseShiftCardDto.observaciones` (ver
   * `common/normalize-observaciones.ts`) — texto libre que un supervisor
   * puede pegar desde el teclado del dispositivo. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeObservaciones(value))
  @IsString()
  @MaxLength(1000)
  observaciones?: string;
}
