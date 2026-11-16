import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

const limpiar = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;

/** Alta de una empresa externa (contratista) del reporte diario — ADMIN. */
export class CreateEmpresaExternaDto {
  @Transform(limpiar)
  @IsString()
  @MinLength(1, { message: 'El nombre es obligatorio.' })
  @MaxLength(60)
  nombre!: string;
}

/** Renombrar o activar/desactivar una empresa externa — ADMIN. */
export class UpdateEmpresaExternaDto {
  @IsOptional()
  @Transform(limpiar)
  @IsString()
  @MinLength(1, { message: 'El nombre es obligatorio.' })
  @MaxLength(60)
  nombre?: string;

  @IsOptional()
  @IsBoolean()
  activa?: boolean;
}
