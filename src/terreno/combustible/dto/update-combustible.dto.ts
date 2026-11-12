import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  Max,
  Min,
} from 'class-validator';

import { FUEL_LITERS_MAX, FUEL_LITERS_MAX_MESSAGE } from '../../../shifts/fuel';

/**
 * Corrección de una carga MANUAL desde el panel (`PATCH /api/combustible/:id`,
 * solo ADMIN): litros/tipo/fecha/lectura mal tipeados o mal leídos del
 * surtidor. Una carga nacida de un cierre de tarjeta NO se edita por acá — se
 * corrige la TARJETA (`PATCH /api/shift-cards/:id`), que sincroniza la carga
 * vinculada y deja el cambio en su historial; el service lo rechaza con
 * `FUEL_LOAD_FROM_CARD`. La foto no es editable (es la evidencia).
 */
export class UpdateCombustibleDto {
  /** Tope `FUEL_LITERS_MAX`: el caso real que esta edición corrige es un
   * «100.000» del display leído como cien mil litros. */
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Max(FUEL_LITERS_MAX, { message: FUEL_LITERS_MAX_MESSAGE })
  litros?: number;

  @IsOptional()
  @IsIn(['PETROLEO', 'BENCINA'])
  tipo?: string;

  @IsOptional()
  @IsDateString()
  fecha?: string;

  /** Lectura del contador al cargar (h en pesados, km en livianos). El
   * contador vigente del equipo solo AVANZA con una lectura mayor (modo
   * `warn`, igual que el alta): corregirla hacia abajo no lo retrocede — si
   * el contador quedó inflado por el typo, se corrige en la ficha del equipo. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1_000_000)
  lectura?: number;
}
