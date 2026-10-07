import { TipoOT } from '@prisma/client';
import { Type } from 'class-transformer';
import {
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

export class CreateIntervencionDto {
  /** UUID v4 generado por el cliente: clave de idempotencia para el reenvío
   * offline. Opcional para no romper a un cliente que no lo manda. */
  @IsOptional()
  @IsUUID('4')
  id?: string;

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

  /** Key temporal (`tmp/<userId>/…`) de la foto del cierre subida por
   * `POST /api/files`. El servicio la reclama a su key definitiva. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  fotoKey?: string;

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
