import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { CreateIntervencionInsumoDto } from './create-intervencion-insumo.dto';

export class ToggleTareaDto {
  @IsBoolean()
  hecha!: boolean;

  /** Qué se hizo en esta tarea — el checklist del taller lo exige al marcar. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;

  /** Key tmp de la foto de respaldo (`POST /api/files`, kind `tarea-photo`). */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  fotoKey?: string;

  /** Insumos usados en ESTA tarea: se descuentan del stock al guardarla,
   * igual que el cierre de una intervención. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateIntervencionInsumoDto)
  insumos?: CreateIntervencionInsumoDto[];

  /** Bodega de la que salen los insumos (el taller usa SIEMPRE la de faena). */
  @IsOptional()
  @IsString()
  branchId?: string;
}
