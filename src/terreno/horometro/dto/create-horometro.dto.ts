import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class CreateHorometroDto {
  @IsString()
  equipoId!: string;

  /**
   * Operador del catálogo propio (`Operator`) — OBLIGATORIO (RFC Supervisión
   * en Terreno, Anexo 2 "operador del catálogo en Trabajos extra + snapshot
   * único": mismo patrón único para Trabajos extra Y la entrada de Flota).
   * `operador` YA NO se recibe acá: `HorometroService` arma el snapshot
   * desde `OperatorsService.assertActive(operatorId).name`, nunca desde
   * texto que mande el cliente. Con `forbidNonWhitelisted: true` global,
   * mandar `operador` en el body ahora es un 400.
   */
  @IsString()
  @IsNotEmpty()
  operatorId!: string;

  @IsIn(['DIURNO', 'NOCTURNO'])
  turno!: string;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1_000_000)
  valorInicial!: number;

  // `valorFinal` SE ELIMINÓ (RFC Supervisión en Terreno, Fase 2): el flujo de
  // un paso de Terreno (entrada+salida en la misma llamada) queda retirado —
  // Flota usa el flujo de dos pasos (`create()` ENTRADA / `salida()` SALIDA),
  // y el flujo de un paso de Supervisión en Terreno pasó a ser
  // `POST /api/shift-cards` (abre) + `POST /api/shift-cards/:id/close`
  // (cierra), ver `src/shifts/*`. Con `forbidNonWhitelisted: true` global,
  // mandar `valorFinal` acá ahora es un 400.

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  nivelCombustible?: number;
}
