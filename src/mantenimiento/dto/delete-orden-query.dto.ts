import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsNumber, IsOptional, Max, Min } from 'class-validator';

/**
 * Opciones de `DELETE /mantenimiento/ordenes/:id` (query string). Pedido del
 * cliente (17/11/2026): borrar operaciones que no corresponden; una
 * preventiva que ya se hizo se registra como hecha antes de borrarla, para
 * que la pauta no la vuelva a crear sola.
 */
export class DeleteOrdenQueryDto {
  /** Solo preventivas de la pauta: registrar sus operaciones como hechas
   * (el ancla desde la que se cuenta la próxima) antes de borrar la tarjeta. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  yaHecha?: boolean;

  /** Horómetro/km al que se hizo; sin él vale la lectura actual del equipo. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1_000_000)
  lecturaMantencion?: number;
}
