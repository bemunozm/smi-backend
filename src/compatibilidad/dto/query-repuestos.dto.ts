import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

const aBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
};

/** Filtros de `GET /api/equipos/:equipoId/repuestos`. */
export class QueryRepuestosDto {
  /**
   * Bodega contra la que se cruza el stock. Sin ella, la principal: la respuesta
   * "sirve pero no lo tengo acá" es la mitad del valor de esta consulta, y una
   * bodega por defecto es mejor que devolver el dato a medias.
   */
  @IsOptional()
  @IsString()
  sucursalId?: string;

  /** Solo los compatibles con saldo disponible en esa bodega. */
  @IsOptional()
  @Transform(aBoolean)
  @IsBoolean()
  soloConStock?: boolean;
}
