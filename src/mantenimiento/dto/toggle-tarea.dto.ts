import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class ToggleTareaDto {
  @IsBoolean()
  hecha!: boolean;

  /** Qué se hizo en esta tarea — el checklist del taller lo exige al marcar. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;

  /** Key tmp de la foto de respaldo (`POST /api/files`, kind `tarea-photo`). */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  fotoKey?: string;
}
