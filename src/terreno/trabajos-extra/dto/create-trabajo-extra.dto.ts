import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
  ValidateNested,
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

/** Una fila del desglose: actividad · dónde · horas máquina. */
export class ActividadDetalleDto {
  @IsIn(ACTIVIDADES)
  actividad!: string;

  /** Tipo de tarea (define cómo se paga): Transporte, Planta o Variado. Una
   * limpieza de silos es SIEMPRE Planta: el servidor lo fija aunque llegue otro. */
  @IsIn(DESTINOS, { message: 'Indicá el tipo de la actividad' })
  lugar!: string;

  /** Nombre de la planta (catálogo `Planta`) cuando `lugar` es PLANTA; se
   * ignora en el resto. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  planta?: string;

  /** Horas máquina de ESTA actividad (desglose; el total a cobrar sigue
   * saliendo de los horómetros). */
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.1, { message: 'Las horas de la actividad deben ser mayores a 0' })
  @Max(24)
  horas!: number;

  /** Qué se hizo en ESTA actividad (p. ej. en qué silo o planta). Opcional en
   * el servidor para no trabar reenvíos offline de versiones anteriores de la
   * app; el formulario la pide al registrar. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  descripcion?: string;
}

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

  /**
   * Fecha elegida explícitamente, que gana sobre `capturedAt`. Dos formas:
   * con hora (panel del admin, `resolveRecordDate`: solo no puede ser
   * futura) o `YYYY-MM-DD` a secas (carga histórica de Terreno: misma
   * ventana de 30 días de las tarjetas y se guarda DENTRO de ese día de
   * negocio chileno — un date-only por `new Date()` caería a medianoche UTC,
   * o sea las ~21:00 del día ANTERIOR en Chile).
   */
  @IsOptional()
  @IsDateString()
  fecha?: string;

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
   * El desglose del report, UNA FILA POR ACTIVIDAD (cliente, 05-11): qué se
   * hizo, dónde (Transporte/Planta/Variado — PLANTA exige LIMPIEZA_SILOS y
   * decir en cuál, regla del servicio) y cuántas horas máquina tomó. Al
   * menos una: un trabajo sin actividad no se puede cobrar ni justificar.
   * `actividades` ya no viaja: el servicio lo deriva de acá (resumen).
   */
  @IsArray()
  @ArrayNotEmpty({ message: 'Agregá al menos una actividad' })
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => ActividadDetalleDto)
  detalle!: ActividadDetalleDto[];

  /**
   * Texto libre para la tarea que no estaba en la lista. El servicio exige que
   * venga cuando alguna fila eligió `OTRO`, y lo ignora cuando no.
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
