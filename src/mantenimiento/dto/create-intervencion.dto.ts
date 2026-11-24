import { TipoOT } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

import { CreateIntervencionInsumoDto } from './create-intervencion-insumo.dto';

/** Tope de fotos por cierre de intervención. */
export const MAX_FOTOS_CIERRE = 10;

/**
 * Lo que describe el cierre de una intervención (qué se hizo, insumos, foto).
 * Lo comparten el alta suelta (`CreateIntervencionDto`) y el cierre atómico
 * de la orden (`FinalizarOrdenDto`); cada uno declara su `id` aparte porque en
 * uno es opcional y en el otro obligatorio (class-validator hereda los
 * decoradores: redeclararlo no le quitaría el `@IsOptional`).
 */
export class IntervencionBaseDto {
  @IsEnum(TipoOT)
  tipo!: TipoOT;

  @IsString()
  @IsNotEmpty()
  detalle!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  horasHombre?: number;

  @IsOptional()
  @IsNumber()
  horometro?: number;

  /** Key temporal (`tmp/<userId>/…`) de UNA foto del cierre subida por
   * `POST /api/files`. Se sigue aceptando por las escrituras offline ya
   * encoladas con una sola foto; si viene junto a `fotoKeys`, va primera. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  fotoKey?: string;

  /** Keys temporales de las fotos del cierre (hasta 10, en orden). El
   * servicio las reclama todas antes de escribir y, si algo falla, las suelta
   * todas. El tope de 10 se vuelve a exigir sumando `fotoKey`. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_FOTOS_CIERRE)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  fotoKeys?: string[];

  /** Bodega de la que salen los insumos. Obligatoria cuando `insumos` viene
   * con filas (el servicio lo exige): cada consumo descuenta stock REAL de
   * esa bodega vía `StockService.issue`. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  branchId?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateIntervencionInsumoDto)
  insumos?: CreateIntervencionInsumoDto[];
}

export class CreateIntervencionDto extends IntervencionBaseDto {
  /** UUID v4 generado por el cliente: clave de idempotencia para el reenvío
   * offline. Opcional para no romper a un cliente que no lo manda. */
  @IsOptional()
  @IsUUID('4')
  id?: string;
}
