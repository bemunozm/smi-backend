import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class UpdateCombustibleDto {
  /**
   * Mismo contrato que `CreateCombustibleDto.fotoUrl` (hallazgo BAJO B3 de
   * la revisión de seguridad, código de Terreno): restringida a una ruta
   * relativa `/uploads/<archivo>` propia, para que no se pueda colar una URL
   * externa como tracking pixel.
   */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  @Matches(/^\/uploads\/[\w.-]+$/)
  fotoUrl?: string;
}
