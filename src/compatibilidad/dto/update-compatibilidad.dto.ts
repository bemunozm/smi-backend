import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Solo la nota es editable. Cambiar `equipoId` o `insumoId` no sería una edición
 * sino otra compatibilidad distinta: para eso se borra y se declara la nueva, y
 * así el `declaradaPorId` sigue correspondiendo a quien realmente la afirmó.
 */
export class UpdateCompatibilidadDto {
  @IsOptional()
  @IsString()
  @MaxLength(240)
  nota?: string;
}
