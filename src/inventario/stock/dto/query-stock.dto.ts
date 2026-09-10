import { TipoInsumo } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

const aBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
};

const recortar = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Filtros de `GET /api/inventario/stock` — la consulta de bodega de PROD-11. */
export class QueryStockDto {
  /**
   * Bodega a consultar. Si no viene, se usa la principal: entrar a la pantalla
   * sin haber elegido sucursal debe mostrar algo útil, no una tabla vacía.
   */
  @IsOptional()
  @IsString()
  sucursalId?: string;

  /** Búsqueda libre por código o nombre. */
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(80)
  q?: string;

  /** Separar suministros de repuestos — el ticket habla de ambos. */
  @IsOptional()
  @IsEnum(TipoInsumo)
  tipo?: TipoInsumo;

  /** Solo los ítems en o bajo su mínimo EN ESA BODEGA. */
  @IsOptional()
  @Transform(aBoolean)
  @IsBoolean()
  bajoStock?: boolean;

  /**
   * Solo los insumos que esta bodega efectivamente maneja (tienen fila de
   * saldo). Por defecto se devuelve el catálogo completo: saber que un repuesto
   * existe pero NO está acá es justamente lo que el mantenedor necesita ver.
   */
  @IsOptional()
  @Transform(aBoolean)
  @IsBoolean()
  soloEnBodega?: boolean;
}
