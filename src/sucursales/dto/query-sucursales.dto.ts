import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

/** `?activa=true` llega como string en la query — se normaliza a boolean. */
const aBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
};

export class QuerySucursalesDto {
  /** Sin el filtro se devuelven todas, activas y dadas de baja. */
  @IsOptional()
  @Transform(aBoolean)
  @IsBoolean()
  activa?: boolean;
}
