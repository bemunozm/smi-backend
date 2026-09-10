import { IsString, MinLength } from 'class-validator';

/**
 * Body de `POST /api/equipos/:equipoId/repuestos/replicar`.
 *
 * Copia las compatibilidades declaradas en `origenId` al equipo de la ruta. Es
 * la respuesta al punto débil del modelo elegido en RFC-12 §4: la relación se
 * ancla a ids (no a `marca`/`modelo`, que son texto libre), y a cambio un equipo
 * nuevo del mismo modelo no hereda solo. Esto cierra ese hueco en un clic, en el
 * momento exacto en que se nota.
 */
export class ReplicarCompatibilidadesDto {
  /** Equipo desde el que se copia. Debe compartir marca y modelo con el destino. */
  @IsString()
  @MinLength(1)
  origenId!: string;
}
