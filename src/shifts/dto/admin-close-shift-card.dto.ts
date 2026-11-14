import { Transform } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { normalizeObservaciones } from '../../common/normalize-observaciones';

/**
 * Cierre de una tarjeta abierta por el ADMINISTRADOR, sin foto ni
 * combustible: el uso quedó colgado (equipo que pasó a fuera de servicio,
 * supervisor que no cerró). Lo único que importa es hasta dónde trabajó.
 */
export class AdminCloseShiftCardDto {
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0, { message: 'La lectura no puede ser negativa.' })
  @Max(1_000_000, { message: 'La lectura no puede superar 1.000.000.' })
  valorFinal!: number;

  /** Por qué se cierra; queda en las observaciones de la tarjeta. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeObservaciones(value))
  @IsString()
  @MaxLength(300)
  motivo?: string;
}
