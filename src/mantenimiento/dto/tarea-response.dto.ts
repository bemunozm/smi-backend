export interface TareaResponseDto {
  id: string;
  texto: string;
  hecha: boolean;
  posicion: number;
  /** Qué se hizo (checklist del taller); null si aún no se completa. */
  notas: string | null;
  /** URL firmada de la foto de respaldo — nunca la key cruda. */
  fotoUrl: string | null;
  /** Quién y cuándo la completó — el "ver detalle" de la tarjeta. */
  hechaPorNombre: string | null;
  hechaAt: string | null;
}
