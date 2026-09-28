import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { TMP_KEY_REGEX } from '../../storage/storage-keys';
import { normalizeObservaciones } from './normalize-observaciones';

export class CloseShiftCardDto {
  /** UUID v4 generado por el CLIENTE en ESTE intento de cierre — la clave de
   * idempotencia del cierre (`RegistroHorometro.closeClientId`, `@unique`):
   * un reintento offline con el MISMO id devuelve la misma tarjeta ya
   * cerrada en vez de reclamar la foto una segunda vez. */
  @IsUUID('4')
  closeClientId!: string;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1_000_000)
  valorFinal!: number;

  /** Litros cargados al cierre — obligatorio (la spec lo pide así), 0
   * permitido (equipo que no cargó combustible en este turno). Tope 10 000 L
   * (B3): los camiones de extracción minera más grandes cargan varios miles
   * de litros, pero no cientos de miles. */
  @IsNumber()
  @Min(0)
  @Max(10_000)
  fuelLiters!: number;

  /** Key `tmp/<userId>/<uuid>.<ext>` de la foto del surtidor/horómetro,
   * subida antes por `POST /api/files` — obligatoria AUN con `fuelLiters ===
   * 0` (la spec lo pide así: siempre queda evidencia fotográfica del
   * cierre). `ShiftsService` la reclama con `StorageService.claimTmp`. */
  @IsString()
  @MaxLength(160)
  @Matches(TMP_KEY_REGEX)
  tmpPhotoKey!: string;

  /** M2(b): 1000 (no 2000) + normalizado (trim, CRLF→LF, 3+ saltos → 2)
   * ANTES de medir el límite — texto libre que un supervisor puede pegar
   * desde el teclado del dispositivo. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeObservaciones(value))
  @IsString()
  @MaxLength(1000)
  observaciones?: string;

  /** Hora del DISPOSITIVO al cerrar la tarjeta — ver `capture-time.ts`. */
  @IsDateString()
  capturedAt!: string;

  /** Hora del DISPOSITIVO al tomar la foto, si difiere de `capturedAt`
   * (ej. la foto se tomó antes y el cierre se confirmó después, offline).
   * Si no viene, se usa `capturedAt` para `RegistroCombustible.fecha`. */
  @IsOptional()
  @IsDateString()
  photoCapturedAt?: string;
}
