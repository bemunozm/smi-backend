import { IsBoolean, IsInt, IsString, Max, Min } from 'class-validator';

/**
 * Marca o desmarca una operación de la pauta como hecha en un hito de una
 * vuelta del ciclo. Es idempotente (`PUT`): mandarla dos veces deja lo mismo.
 */
export class SetMaintenanceRecordDto {
  @IsString()
  planItemId!: string;

  @IsInt()
  @Min(1)
  @Max(10_000)
  cycle!: number;

  @IsInt()
  @Min(1)
  @Max(1_000_000)
  milestone!: number;

  @IsBoolean()
  done!: boolean;
}
