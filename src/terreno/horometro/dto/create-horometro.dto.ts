import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

import { SHIFT_TYPES, type ShiftType } from '../../../shifts/shift-type';

export class CreateHorometroDto {
  /** UUID v4 generado por el cliente: PK del registro y clave de idempotencia
   * para el reenvío offline. Opcional para no romper a un cliente que no lo
   * manda. */
  @IsOptional()
  @IsUUID('4')
  id?: string;

  /** Hora del DISPOSITIVO al registrar la entrada — ver `capture-time.ts`.
   * Es `fecha` de la fila; sin ella, la hora del servidor. */
  @IsOptional()
  @IsDateString()
  capturedAt?: string;

  @IsString()
  equipoId!: string;

  /**
   * Operador del catálogo propio (`Operator`) — OBLIGATORIO (mismo patrón
   * para Trabajos extra y la entrada de Flota).
   * `operador` no se recibe acá: `HorometroService` arma el snapshot
   * desde `OperatorsService.assertActive(operatorId).name`, nunca desde
   * texto que mande el cliente. Con `forbidNonWhitelisted: true` global,
   * mandar `operador` en el body es un 400.
   */
  @IsString()
  @IsNotEmpty()
  operatorId!: string;

  @IsIn(SHIFT_TYPES)
  turno!: ShiftType;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1_000_000)
  valorInicial!: number;

  // No hay `valorFinal`: Flota usa el flujo de dos pasos (`create()` ENTRADA /
  // `salida()` SALIDA) y Supervisión en Terreno usa `POST /api/shift-cards`
  // (abre) + `POST /api/shift-cards/:id/close` (cierra), ver `src/shifts/*`.
  // Con `forbidNonWhitelisted: true` global, mandar `valorFinal` acá es un 400.

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  nivelCombustible?: number;
}
