import { TipoOT } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

import { CreateIntervencionInsumoDto } from './create-intervencion-insumo.dto';

export class CreateIntervencionDto {
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

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateIntervencionInsumoDto)
  insumos?: CreateIntervencionInsumoDto[];
}
