import { Transform } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
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
  'LIMPIEZA_PECAS',
  'BARRIDO_CANCHA',
  'LIMPIEZA_ROMANA',
  'LIMPIEZA_RUTA',
  // Válvula de escape para la tarea que no estaba en la lista. Viaja junto a
  // `otraActividad`, que es donde va el texto.
  'OTRO',
] as const;

/**
 * Cómo se lee cada actividad en el registro de cambios y en el aviso al
 * administrador. Repite las etiquetas de la pantalla (`types/trabajosExtra.ts`
 * en el frontend): un aviso que dijera `HACER_PETRIL` no lo entiende nadie.
 */
/**
 * Dónde se hizo el trabajo (pedido del cliente, espejo de la columna
 * «Planta» de su planilla): TRANSPORTE, una PLANTA concreta (solo para
 * limpieza de silos — la regla vive en `TrabajosExtraService.validar`) o
 * VARIADO cuando mezcla destinos.
 */
export const DESTINOS = ['TRANSPORTE', 'PLANTA', 'VARIADO'] as const;

export const DESTINO_LABEL: Record<string, string> = {
  TRANSPORTE: 'Transporte',
  PLANTA: 'Planta',
  VARIADO: 'Variado',
};

export const ACTIVIDAD_LABEL: Record<string, string> = {
  REGULACION_CARGA: 'Regulación y carga',
  LIMPIEZA_CANCHA: 'Limpieza de cancha',
  SOLTAR_MATERIAL: 'Soltar material',
  LIMPIEZA_SILOS: 'Limpieza de silos',
  HACER_PETRIL: 'Hacer pretil',
  ARREGLO_CANCHA: 'Arreglo cancha',
  LIMPIEZA_PECAS: 'Limpieza de pecas',
  BARRIDO_CANCHA: 'Barrido de cancha',
  LIMPIEZA_ROMANA: 'Limpieza de romana',
  LIMPIEZA_RUTA: 'Limpieza de ruta',
  OTRO: 'Otro',
};

export class CreateTrabajoExtraDto {
  /** UUID v4 generado por el cliente: clave de idempotencia para el reenvío
   * offline. Opcional para no romper a un cliente que no lo manda. */
  @IsOptional()
  @IsUUID('4')
  id?: string;

  /** Hora del DISPOSITIVO al registrar el trabajo — ver `capture-time.ts`. */
  @IsOptional()
  @IsDateString()
  capturedAt?: string;

  @IsString()
  equipoId!: string;

  /**
   * Operador del catálogo propio (`Operator`) — OBLIGATORIO. `operador` no
   * se recibe acá: el servicio lo arma desde
   * `OperatorsService.assertActive(operatorId).name`, nunca desde texto que
   * mande el cliente. Con `forbidNonWhitelisted: true` global, mandar
   * `operador` en el body es un 400.
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

  /** N° del report en papel que respalda el trabajo — obligatorio: el
   * cliente folia cada report y el Excel que exporta el admin lo lleva. */
  @IsString()
  @IsNotEmpty({ message: 'Indicá el número del report' })
  @MaxLength(30)
  reportNumero!: string;

  /** Dónde se hizo — obligatorio; lo declara el supervisor. PLANTA exige
   * `planta` y que las actividades incluyan LIMPIEZA_SILOS (regla del
   * servicio). */
  @IsIn(DESTINOS, { message: 'Indicá dónde se hizo el trabajo' })
  destino!: string;

  /** Nombre de la planta (catálogo `Planta` del reporte diario) cuando
   * `destino` es PLANTA; se ignora en el resto. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  planta?: string;

  /**
   * Foto del report en papel — OBLIGATORIA (pedido del cliente: el trabajo
   * se cobra contra el report). Key `tmp/` subida por `POST /api/files`; el
   * create la reclama (`claimTmp`), mismo patrón que `Hallazgo.fotoKey`.
   */
  @IsString()
  @IsNotEmpty({ message: 'La foto del report es obligatoria' })
  fotoKey!: string;

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
