import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import {
  ProduccionTurnoDto,
  ReportePersonalDto,
  ReportePlantaDto,
  ReporteTolvaDto,
  ReporteTraspasoDto,
} from './create-reporte-diario.dto';

export class UpdateReporteDiarioDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(3)
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => ProduccionTurnoDto)
  produccion?: ProduccionTurnoDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => ReporteTolvaDto)
  tolvas?: ReporteTolvaDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReportePlantaDto)
  plantas?: ReportePlantaDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => ReporteTraspasoDto)
  traspasos?: ReporteTraspasoDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  empresaIds?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReportePersonalDto)
  personal?: ReportePersonalDto[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  observaciones?: string;
}
