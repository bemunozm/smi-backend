import { EstadoEquipo } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Filtros de `GET /api/equipos`. Con `whitelist + forbidNonWhitelisted`
 * activos globalmente, cualquier query param no declarado acá hace fallar la
 * request — así que todo filtro nuevo se agrega aquí explícitamente.
 */
export class QueryEquiposDto {
  @IsOptional()
  @IsEnum(EstadoEquipo)
  estado?: EstadoEquipo;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  tipo?: string;

  /** Búsqueda libre por código, marca o modelo. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(60)
  q?: string;
}
