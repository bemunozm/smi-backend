import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Filtros de `GET /api/operators`. Con `whitelist + forbidNonWhitelisted`
 * activos globalmente, cualquier query param no declarado acá hace fallar la
 * request. Clon de `QueryBranchDto`.
 */
export class QueryOperatorDto {
  /** Ej: el selector del Módulo A solo quiere los activos. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(60)
  q?: string;
}
