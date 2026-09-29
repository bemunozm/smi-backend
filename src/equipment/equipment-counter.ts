/**
 * Reconciliación del contador de uso de la ficha del equipo
 * (`currentHourmeter`/`currentMileage`) — extraído de `HorometroService`
 * (antes privado, duplicado conceptualmente por Fase 2) para que tanto Flota
 * (`HorometroService.create`/`salida`) como Supervisión en Terreno
 * (`ShiftsService.openCard`/`closeCard`) compartan la MISMA guarda
 * monotónica (hallazgo B1: el contador de un equipo nunca retrocede) en vez
 * de reimplementarla.
 *
 * `mode` es la única diferencia de comportamiento entre los dos callers:
 *   - `'reject'` (Flota, y el cierre de tarjeta): comportamiento histórico —
 *     una lectura menor que la vigente se RECHAZA con 400. Motivo: fuera del
 *     flujo de Supervisión en Terreno no hay "auditoría, no bloqueo" —
 *     rechazar temprano evita que un typo/OCR mal leído ensucie el contador.
 *   - `'warn'` (apertura de tarjeta, RFC Supervisión en Terreno §Diseño):
 *     una lectura menor que la vigente NO se rechaza ni mueve el contador —
 *     se acepta y se marca `belowPrevious: true` para que el caller audite
 *     (`RegistroHorometro.belowPreviousReading`). El motivo del modo warn en
 *     la apertura es que el supervisor puede estar frente al equipo leyendo
 *     el horómetro físico real, que puede ir por detrás del último valor que
 *     el sistema conoce (p. ej. un horómetro reemplazado o una lectura previa
 *     mal tipeada) — bloquear la apertura de un turno por eso dejaría al
 *     equipo inutilizable hasta que alguien corrija el dato a mano.
 */
import { BadRequestException } from '@nestjs/common';
import { ControlUnit, Prisma } from '@prisma/client';

/** Contadores vigentes de la ficha del equipo que gobiernan la reconciliación
 * (guía §4): solo uno de los dos aplica, según `controlUnit`. */
export interface EquipoContador {
  controlUnit: ControlUnit;
  currentHourmeter: number | null;
  currentMileage: number | null;
}

export type ReconcileMode = 'reject' | 'warn';

export interface ReconcileResult {
  /** `true` solo en modo `'warn'`, cuando `nuevoValor` era menor que el
   * contador vigente — el contador NO se movió en ese caso. Siempre `false`
   * en modo `'reject'` (si hubiera pasado, ya se lanzó la excepción). */
  belowPrevious: boolean;
}

/**
 * Único punto donde se lee/escribe el contador de uso de la ficha del
 * equipo. Reusado por `HorometroService.create()`/`salida()` (modo
 * `'reject'`, Flota) y por `ShiftsService.openCard()`/`closeCard()` (modo
 * `'warn'` al abrir, `'reject'` al cerrar — ver comentario de cabecera).
 */
export async function reconcileEquipmentCounter(
  tx: Prisma.TransactionClient,
  equipoId: string,
  equipo: EquipoContador,
  nuevoValor: number,
  mode: ReconcileMode = 'reject',
): Promise<ReconcileResult> {
  const esHoras = equipo.controlUnit === ControlUnit.HOURS;
  const vigente = esHoras ? equipo.currentHourmeter : equipo.currentMileage;
  const unidad = esHoras ? 'h' : 'km';
  const nombreContador = esHoras ? 'horómetro' : 'kilometraje';

  if (vigente != null && nuevoValor < vigente) {
    if (mode === 'warn') {
      // Se audita (el caller marca `belowPreviousReading`), pero NO se
      // mueve el contador ni se rechaza la operación.
      return { belowPrevious: true };
    }
    throw new BadRequestException(
      `La lectura (${nuevoValor} ${unidad}) no puede ser menor que el ${nombreContador} actual del equipo (${vigente} ${unidad})`,
    );
  }

  // B6 (auditoría de seguridad): `updateMany` con guarda en el `where` — no
  // un `update` incondicional — para que el contador NUNCA pueda retroceder
  // aunque dos reconciliaciones concurrentes lean el mismo `equipo.currentX`
  // desfasado (TOCTOU clásico: el chequeo de arriba compara contra el valor
  // que YA leyó el caller antes de entrar acá, que puede estar stale). Esta
  // escritura vuelve a comparar, atómicamente dentro de la transacción,
  // contra el valor VIGENTE de la fila en el momento del UPDATE. Si otra
  // transacción concurrente ya adelantó el contador más allá de `nuevoValor`
  // entre esa lectura y esta escritura, el `where` no matchea ninguna fila —
  // no se hace nada, y el contador queda igual de correcto (monotonicidad
  // preservada) sin necesidad de reintentar ni de lanzar: el objetivo
  // (reflejar la lectura más alta) ya lo cumplió la transacción ganadora.
  if (esHoras) {
    await tx.equipment.updateMany({
      where: {
        id: equipoId,
        OR: [
          { currentHourmeter: null },
          { currentHourmeter: { lt: nuevoValor } },
        ],
      },
      data: { currentHourmeter: nuevoValor },
    });
  } else if (equipo.controlUnit === ControlUnit.KM) {
    await tx.equipment.updateMany({
      where: {
        id: equipoId,
        OR: [{ currentMileage: null }, { currentMileage: { lt: nuevoValor } }],
      },
      data: { currentMileage: nuevoValor },
    });
  }

  return { belowPrevious: false };
}
