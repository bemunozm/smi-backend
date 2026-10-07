import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { normalizeComparable } from '../common/concurrency/expected-fields';
import { formatNumber } from '../common/format/number';
import { PrismaService } from '../common/prisma/prisma.service';

/** Quién edita: sale de la sesión, nunca del body. */
export interface Editor {
  id: string;
  name: string;
}

/** Qué tipo de registro se editó. Crece cuando otro dominio lo use. */
export type ChangeLogEntity =
  'trabajo_extra' | 'hallazgo' | 'shift_card' | 'maintenance_plan';

/** Un dato que cambió, con los valores ya legibles para una persona. */
export interface FieldChange {
  field: string;
  label: string;
  before: string;
  after: string;
}

export interface ChangeLogEntry {
  id: string;
  userId: string;
  userName: string;
  changes: FieldChange[];
  createdAt: Date;
}

/** Un campo comparable: cómo se llama en pantalla y cómo se lee su valor. */
export interface ComparableField<T> {
  field: keyof T & string;
  label: string;
  /** Valor legible. Por defecto, el valor tal cual o «—» si está vacío. */
  format?: (value: T[keyof T]) => string;
}

/**
 * Lectura por defecto de un campo de texto o número. Un valor compuesto
 * (arreglo, objeto) necesita su propio `format`: convertido a texto así nomás
 * se leería «[object Object]», y eso no le dice nada al administrador.
 */
const vacio = (v: unknown): string => {
  if (v == null || v === '') return '—';
  if (typeof v === 'number') return formatNumber(v);
  return typeof v === 'string' || typeof v === 'boolean'
    ? String(v)
    : JSON.stringify(v);
};

/**
 * Compara dos versiones de un registro y devuelve solo lo que cambió.
 *
 * La comparación es por contenido (`normalizeComparable`): dos arreglos con
 * las mismas actividades, un texto con espacios en los bordes o `null` frente
 * a texto vacío no son un cambio. No se compara el texto legible porque el
 * formato redondea los números, y una diferencia que se escribe en la base
 * tiene que quedar en el historial aunque se vea igual.
 */
export function diffFields<T>(
  before: T,
  after: T,
  fields: readonly ComparableField<T>[],
): FieldChange[] {
  return fields.flatMap(({ field, label, format }) => {
    if (
      normalizeComparable(before[field]) === normalizeComparable(after[field])
    ) {
      return [];
    }
    const leer = format ?? vacio;
    return [
      { field, label, before: leer(before[field]), after: leer(after[field]) },
    ];
  });
}

/**
 * Trazabilidad de cambios a registros ya enviados.
 * Ver el modelo `ChangeLog` en `schema.prisma`.
 */
@Injectable()
export class ChangeLogService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Guarda un cambio. Recibe el cliente de la transacción para que la fila
   * se escriba junto con la edición o no se escriba: una edición sin su
   * registro es justo lo que el historial debe impedir:
   * reescribir un cambio ya registrado.
   */
  record(
    tx: Prisma.TransactionClient,
    entity: ChangeLogEntity,
    entityId: string,
    user: Editor,
    changes: FieldChange[],
  ) {
    return tx.changeLog.create({
      data: {
        entity,
        entityId,
        userId: user.id,
        userName: user.name,
        changes: changes as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /** Los cambios de un registro, del más reciente al más viejo. */
  async findFor(
    entity: ChangeLogEntity,
    entityId: string,
  ): Promise<ChangeLogEntry[]> {
    const rows = await this.prisma.changeLog.findMany({
      where: { entity, entityId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      userName: r.userName,
      changes: r.changes as unknown as FieldChange[],
      createdAt: r.createdAt,
    }));
  }
}
