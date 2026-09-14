import { ControlUnit, EquipmentClass, EquipmentStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Filtros de `GET /api/equipment`. Con `whitelist + forbidNonWhitelisted`
 * activos globalmente, cualquier query param no declarado acá hace fallar la
 * request — así que todo filtro nuevo se agrega aquí explícitamente.
 */
export class QueryEquipmentDto {
  @IsOptional()
  @IsEnum(EquipmentStatus)
  status?: EquipmentStatus;

  /** Filtro principal de Flota (RFC T01 §2, R8): liviano vs. pesado. */
  @IsOptional()
  @IsEnum(EquipmentClass)
  equipmentClass?: EquipmentClass;

  @IsOptional()
  @IsEnum(ControlUnit)
  controlUnit?: ControlUnit;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  type?: string;

  @IsOptional()
  @IsString()
  homeBranchId?: string;

  /** Búsqueda libre por código interno, patente, marca o modelo. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(60)
  q?: string;
}
