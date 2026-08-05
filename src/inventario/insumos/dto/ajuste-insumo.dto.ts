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

  @IsOptional()
  @IsString()
  @MaxLength(240)
  observacion?: string;
}
