/**
 * Reconciliación del contador de uso de la ficha del equipo
 * (`currentHourmeter`/`currentMileage`) — extraído de `HorometroService`
 * para que Flota (`HorometroService.create`/`salida`) y Supervisión en
 * Terreno (`ShiftsService.openCard`/`closeCard`) compartan la MISMA guarda
 * monotónica (el contador de un equipo nunca retrocede) en vez de
 * reimplementarla.
 *
 * `mode` es la única diferencia de comportamiento entre los dos callers:
 *   - `'reject'` (Flota, y el cierre de tarjeta):
 *     una lectura menor que la vigente se RECHAZA con 400. Motivo: fuera del
 *     flujo de Supervisión en Terreno no hay "auditoría, no bloqueo" —
 *     rechazar temprano evita que un typo/OCR mal leído ensucie el contador.
 *   - `'warn'` (apertura de tarjeta):
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

import { ERROR_CODES } from '../common/errors/error-codes';
import { formatNumber } from '../common/format/number';

/** Contadores vigentes de la ficha del equipo que gobiernan la reconciliación
 * : solo uno de los dos aplica, según `controlUnit`. */
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
  /** `true` solo en modo `'warn'`, cuando `nuevoValor` adelantaba al
   * contador más de lo posible (`SALTO_MAXIMO`): casi seguro un error de
   * tipeo. El registro se guarda igual, pero el contador NO se movió. */
  implausibleJump?: boolean;
}

/**
 * Cuánto puede adelantar UNA lectura al contador vigente del equipo. Un
 * equipo hace a lo sumo 24 h por día: 1.000 h son ~6 semanas sin registrar
 * nada, y 20.000 km son semanas de camioneta. Más que eso es un dígito de
 * más o de menos (pasó con el SEM05: 4.606 h con lecturas de ~2.600 h), y
 * dejarlo pasar deja el contador inflado — nunca retrocede solo. Un salto
 * real así (horómetro reemplazado, equipo que vuelve tras meses) lo carga el
 * administrador en la ficha del equipo.
 */
export const SALTO_MAXIMO = { HOURS: 1000, KM: 20000 } as const;

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
      `La lectura (${formatNumber(nuevoValor)} ${unidad}) no puede ser menor que el ${nombreContador} actual del equipo (${formatNumber(vigente)} ${unidad})`,
    );
  }

  // Sin contador previo (o en 0, el valor de un equipo recién dado de alta)
  // no hay contra qué medir el salto: la primera lectura lo fija.
  const salto = esHoras ? SALTO_MAXIMO.HOURS : SALTO_MAXIMO.KM;
  if (vigente != null && vigente > 0 && nuevoValor - vigente > salto) {
    if (mode === 'warn') {
      // Terreno nunca se bloquea (un cierre offline rechazado quedaría
      // trabado para siempre): el registro se guarda con su lectura, pero el
      // contador del equipo no se contamina.
      return { belowPrevious: false, implausibleJump: true };
    }
    throw new BadRequestException({
      message: `La lectura (${formatNumber(nuevoValor)} ${unidad}) está ${formatNumber(nuevoValor - vigente)} ${unidad} por encima del ${nombreContador} actual del equipo (${formatNumber(vigente)} ${unidad}). Revisa que no sea un error de tipeo; si es correcta, actualiza primero el ${nombreContador} en la ficha del equipo.`,
      code: ERROR_CODES.COUNTER_JUMP_IMPLAUSIBLE,
    });
  }

  // `updateMany` con la guarda en el `where` — no
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

/**
 * La lectura más alta que registran HOY los registros del equipo: tarjetas
 * de turno / horómetro de Flota (inicial y final) y cargas de combustible con
 * lectura. `null` si no tiene ninguna.
 */
async function maxLecturaRegistrada(
  tx: Prisma.TransactionClient,
  equipoId: string,
): Promise<number | null> {
  const [tarjetas, cargas] = await Promise.all([
    tx.registroHorometro.aggregate({
      where: { equipoId },
      _max: { valorInicial: true, valorFinal: true },
    }),
    tx.registroCombustible.aggregate({
      where: { equipoId, lectura: { not: null } },
      _max: { lectura: true },
    }),
  ]);
  const valores = [
    tarjetas._max.valorInicial,
    tarjetas._max.valorFinal,
    cargas._max.lectura,
  ].filter((v): v is number => v != null);
  return valores.length > 0 ? Math.max(...valores) : null;
}

/**
 * Se llama DESPUÉS de corregir hacia abajo o eliminar un registro con
 * lectura, dentro de la misma transacción. Si esa lectura era la que había
 * fijado el contador del equipo (contador === `lecturaRetirada`), el
 * contador vuelve a la lectura más alta que queda registrada: corregir un
 * typo tiene que arreglar también el contador, no dejarlo inflado para
 * siempre. Si el contador vino de otro lado (otra lectura, o el
 * administrador en la ficha), no se toca.
 */
export async function releaseRemovedReading(
  tx: Prisma.TransactionClient,
  equipoId: string,
  lecturaRetirada: number | null | undefined,
): Promise<void> {
  if (lecturaRetirada == null) return;
  const equipo = await tx.equipment.findUnique({
    where: { id: equipoId },
    select: { controlUnit: true, currentHourmeter: true, currentMileage: true },
  });
  if (!equipo) return;
  const esHoras = equipo.controlUnit === ControlUnit.HOURS;
  const vigente = esHoras ? equipo.currentHourmeter : equipo.currentMileage;
  if (vigente == null || vigente !== lecturaRetirada) return;

  const restante = await maxLecturaRegistrada(tx, equipoId);
  // Sin otras lecturas no hay a qué volver: queda para el administrador.
  if (restante == null || restante >= vigente) return;

  // La guarda en el `where` (contador todavía igual al retirado) evita pisar
  // una lectura más alta que otra transacción haya escrito entretanto.
  if (esHoras) {
    await tx.equipment.updateMany({
      where: { id: equipoId, currentHourmeter: vigente },
      data: { currentHourmeter: restante },
    });
  } else {
    await tx.equipment.updateMany({
      where: { id: equipoId, currentMileage: vigente },
      data: { currentMileage: restante },
    });
  }
}
