import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body de `POST /api/compatibilidades` — "este repuesto sirve para esta máquina".
 *
 * `declaradaPorId` NO viene en el body a propósito: sale de la sesión en el
 * controller. Una afirmación técnica sin autor verificable no se puede auditar
 * después, que es justamente lo que pasa hoy con el conocimiento del taller.
 */
export class CreateCompatibilidadDto {
  @IsString()
  @MinLength(1)
  equipoId!: string;

  @IsString()
  @MinLength(1)
  insumoId!: string;

  /** Salvedad: "solo desde nº serie 4500", "requiere adaptador". */
  @IsOptional()
  @IsString()
  @MaxLength(240)
  nota?: string;
}
