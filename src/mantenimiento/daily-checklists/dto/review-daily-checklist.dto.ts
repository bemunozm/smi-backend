import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/** La decisión del supervisor sobre un checklist (Módulo 3 · R25). */
export class ReviewDailyChecklistDto {
  @IsIn(['ACCEPTED', 'REJECTED'], {
    message: 'La decisión tiene que ser aceptar o rechazar.',
  })
  decision!: 'ACCEPTED' | 'REJECTED';

  /** Obligatorio al rechazar (lo exige el servicio): qué hay que corregir. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;

  /**
   * El envío que el supervisor revisó (`submissionCount`). Si el mantenedor
   * lo corrigió mientras tanto, la decisión no aplica a lo que se ve ahora.
   */
  @IsInt()
  @Min(1)
  submission!: number;
}
