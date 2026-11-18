import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

import { formatNumber } from '../../common/format/number';
import { TMP_KEY_REGEX } from '../../storage/storage-keys';
import { ADBLUE_MAX_LITERS } from '../adblue';
import { IsDateOnly } from '../date-only';
import { FUEL_LITERS_MAX, FUEL_LITERS_MAX_MESSAGE } from '../fuel';
import { SHIFT_TYPES, type ShiftType } from '../shift-type';

/**
 * `POST /api/shift-cards/:id/fuel-loads` — carga de combustible en una
 * tarjeta de liviano ABIERTA, sin cerrarla (pedido del cliente: a veces se
 * carga y la camioneta se sigue usando). Se puede repetir cuantas veces haga
 * falta; la tarjeta se cierra después con el flujo normal de cierre.
 */
export class CreateShiftCardFuelLoadDto {
  /** UUID v4 generado por el CLIENTE: PK de la carga y clave de
   * idempotencia del reenvío offline (reintento propio → la misma carga;
   * id de otro usuario → 409 `ID_CONFLICT`). */
  @IsUUID('4')
  id!: string;

  /** Litros cargados: > 0 (una carga intermedia sin litros no es carga) y
   * el mismo tope que el cierre (`FUEL_LITERS_MAX`). */
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive({ message: 'Los litros deben ser mayores que 0.' })
  @Max(FUEL_LITERS_MAX, { message: FUEL_LITERS_MAX_MESSAGE })
  liters!: number;

  /** Kilometraje del liviano AL CARGAR. Obligatorio: es la `lectura` de la
   * carga y adelanta el contador del equipo. Mismos límites que la lectura
   * final del cierre; el ≥ inicial de la tarjeta lo valida el servicio. */
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0, { message: 'La lectura no puede ser negativa.' })
  @Max(1_000_000, { message: 'La lectura no puede superar 1.000.000.' })
  reading!: number;

  /** AdBlue cargado junto con esta carga, en litros (omitido o `null` = sin
   * AdBlue). Mismo tope que el AdBlue del cierre. */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive({ message: 'Los litros de AdBlue deben ser mayores que 0.' })
  @Max(ADBLUE_MAX_LITERS, {
    message: `El AdBlue no puede superar los ${formatNumber(ADBLUE_MAX_LITERS)} L`,
  })
  adBlueLiters?: number | null;

  /** Key `tmp/<userId>/<uuid>.<ext>` de la foto del surtidor, subida antes
   * por `POST /api/files` — mismo campo y misma regla que el cierre: con
   * litros (> 0, siempre en esta carga) la foto es obligatoria. Sin
   * `@IsOptional` a propósito: faltar es 400 de validación. */
  @IsString({ message: 'Falta la foto del surtidor.' })
  @MaxLength(160)
  @Matches(TMP_KEY_REGEX)
  tmpPhotoKey!: string;

  /** Hora del DISPOSITIVO al registrar la carga — ver `capture-time.ts`. */
  @IsDateString()
  capturedAt!: string;

  /** Hora del DISPOSITIVO al tomar la foto, si difiere de `capturedAt`
   * (EXIF). Inválida o fuera de rango se ignora (cae a `capturedAt`). */
  @IsOptional()
  @IsDateString()
  photoCapturedAt?: string;

  /** Turno de quien CARGA (`YYYY-MM-DD` + tipo), igual que el cierre del
   * liviano: la carga se fecha en el día de ese turno. Opcionales, pero
   * van juntos; sin ellos manda el reloj (`shiftDayOf`). */
  @ValidateIf((o: CreateShiftCardFuelLoadDto) => o.shiftType !== undefined)
  @IsDateOnly()
  shiftDate?: string;

  @ValidateIf((o: CreateShiftCardFuelLoadDto) => o.shiftDate !== undefined)
  @IsIn(SHIFT_TYPES)
  shiftType?: ShiftType;
}
