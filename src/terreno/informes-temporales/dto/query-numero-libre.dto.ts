import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

/** `GET /api/informes-temporales/numero-libre?numero=`. */
export class QueryNumeroLibreDto {
  @Type(() => Number)
  @IsInt({ message: 'El N° del informe es un número entero.' })
  @Min(1)
  @Max(1_000_000)
  numero!: number;
}
