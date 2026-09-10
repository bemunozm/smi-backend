import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/** Body de `POST /api/inventario/insumos/:id/ajuste` — conteo físico de bodega. */
export class AjusteInsumoDto {
  /** Cantidad real contada. El sistema calcula la diferencia contra su saldo. */
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  stockContado!: number;

  /**
   * Bodega que se está inventariando. Sin ella, la principal: el conteo físico
   * siempre ocurre EN un lugar, nunca sobre el total de la empresa.
   */
  @IsOptional()
  @IsString()
  sucursalId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  observacion?: string;
}
