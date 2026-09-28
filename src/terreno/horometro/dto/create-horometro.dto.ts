import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class CreateHorometroDto {
  @IsString()
  equipoId!: string;

  @IsString()
  operador!: string;

  /** Operador del catálogo propio (`Operator`), ADITIVO sobre `operador`
   * (snapshot de texto que el frontend ya envía desde el modal de entrada de
   * Flota — RFC Supervisión en Terreno §Diseño). Opcional: sigue existiendo
   * uso de Flota sin operador de catálogo hasta que el frontend migre por
   * completo. Si viene, `HorometroService` valida que exista Y esté activo
   * (404 / 409 `OPERATOR_INACTIVE`, ver `OperatorsService.assertActive`). */
  @IsOptional()
  @IsString()
  operatorId?: string;

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
