import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Filtros de `GET /api/branches`. Con `whitelist + forbidNonWhitelisted`
 * activos globalmente, cualquier query param no declarado acá hace fallar la
 * request.
 */
export class QueryBranchDto {
  /** Ej: los selectores de Flota/Inventario solo quieren las activas. */
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
