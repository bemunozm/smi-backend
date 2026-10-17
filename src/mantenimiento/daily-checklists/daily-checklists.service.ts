import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ChecklistStatus, MovementReason, Prisma } from '@prisma/client';

import { todayInBusinessTimeZone } from '../../common/dates/business-time';
import { DOMAIN_EVENTS } from '../../common/events/domain-events';
import type {
  ChecklistReviewedEvent,
  ChecklistSubmittedEvent,
} from '../../common/events/domain-events';
import { formatNumber } from '../../common/format/number';
import { createOrReturn } from '../../common/idempotency/create-or-return';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Editor } from '../../change-log/change-log.service';
import {
  StockService,
  type PendingStockEvents,
} from '../../inventory/stock.service';
import { formatDateOnly, parseDateOnlyUtc } from '../../shifts/date-only';
import { StorageService } from '../../storage/storage.service';
import { checklistProblems, tally } from './daily-checklist-rules';
import type { ResubmitDailyChecklistDto } from './dto/resubmit-daily-checklist.dto';
import type { ReviewDailyChecklistDto } from './dto/review-daily-checklist.dto';
import type {
  DailyChecklistEntryDto,
  SubmitDailyChecklistDto,
} from './dto/submit-daily-checklist.dto';

/** Hasta cuántos días atrás se acepta un checklist (envío retrasado sin señal). */
const MAX_DIAS_ATRAS = 7;
const MS_DIA = 24 * 60 * 60 * 1000;

interface InsumoUsado {
  itemId: string;
  sku: string;
  name: string;
  quantity: number;
}

export interface ChecklistReviewView {
  decision: 'ACCEPTED' | 'REJECTED';
  comment: string | null;
  reviewerName: string;
  submission: number;
  createdAt: Date;
}

export interface DailyChecklistSummary {
  id: string;
  equipment: { id: string; internalCode: string };
  /** `YYYY-MM-DD`. */
  date: string;
  /** Horómetro u odómetro anotado en el checklist (no toca el del equipo). */
  counter: number;
  status: ChecklistStatus;
  mechanicName: string;
  submittedAt: Date;
  /** 1 = primer envío; sube con cada corrección tras un rechazo. */
  submissionCount: number;
  /** Ítems revisados o con mantención. */
  declared: number;
  /** Ítems con «Se hizo mantención». */
  maintained: number;
  /** Fotos adjuntas en todo el checklist. */
  photos: number;
  /** La última validación del supervisor, o `null` si nunca se revisó. */
  lastReview: ChecklistReviewView | null;
}

export interface DailyChecklistDetail extends DailyChecklistSummary {
  entries: {
    itemId: string | null;
    itemName: string;
    status: string;
    description: string | null;
    note: string | null;
    temperature: number | null;
    /**
     * Fotos con URL firmada. El `id` (nombre del archivo, nunca la ruta del
     * bucket) sirve para conservarla al corregir un checklist rechazado.
     */
    photos: { id: string; url: string }[];
    supplies: InsumoUsado[];
  }[];
  /** Todas las validaciones, de la más vieja a la más nueva (auditoría). */
  reviews: ChecklistReviewView[];
}

const CHECKLIST_INCLUDE = {
  entries: { orderBy: { position: 'asc' } },
  reviews: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.DailyChecklistInclude;

type ChecklistCompleto = Prisma.DailyChecklistGetPayload<{
  include: typeof CHECKLIST_INCLUDE;
}>;

type Equipo = { id: string; internalCode: string };

/** Lo validado de las entradas, listo para escribir. */
interface EntradasPreparadas {
  catalogo: Awaited<ReturnType<DailyChecklistsService['items']>>;
  insumoPorId: Map<string, { id: string; sku: string; name: string }>;
  usaInsumos: boolean;
}

/** El nombre del archivo de una key (`checklist-photos/<uuid>.jpg` → `<uuid>.jpg`). */
function idDeFoto(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1);
}

/**
 * Checklist diario del mantenedor (Módulo 2 · R23 + R24) y su validación por
 * el supervisor (Módulo 3 · R25). Por equipo y por día, cada ítem del
 * catálogo con «se hizo mantención», «se revisó» o «no se revisó», las fotos
 * y los insumos usados (que se descuentan del stock). El supervisor lo acepta
 * —y el equipo se libera para abrir turno, ver `checklist-gate.ts`— o lo
 * rechaza con un comentario, y el mantenedor lo corrige y lo reenvía.
 */
@Injectable()
export class DailyChecklistsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly stock: StockService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** El catálogo de ítems vigente, en el orden de la planilla. */
  items() {
    return this.prisma.checklistItem.findMany({
      where: { isActive: true },
      orderBy: { position: 'asc' },
      select: {
        id: true,
        name: true,
        position: true,
        requiresPhoto: true,
        requiresTemperature: true,
      },
    });
  }

  /**
   * Los checklists de un día, de un equipo o en ciertos estados (los
   * pendientes del supervisor: `status=SUBMITTED`), del más reciente al más
   * viejo.
   */
  async list(filtro: {
    date?: string;
    equipmentId?: string;
    status?: ChecklistStatus[];
  }): Promise<DailyChecklistSummary[]> {
    const filas = await this.prisma.dailyChecklist.findMany({
      where: {
        ...(filtro.date ? { date: parseDateOnlyUtc(filtro.date) } : {}),
        ...(filtro.equipmentId ? { equipmentId: filtro.equipmentId } : {}),
        ...(filtro.status?.length ? { status: { in: filtro.status } } : {}),
      },
      include: CHECKLIST_INCLUDE,
      orderBy: [{ date: 'desc' }, { submittedAt: 'desc' }],
      take: 200,
    });
    const codigos = await this.codigos(filas.map((f) => f.equipmentId));
    return filas.map((f) => this.resumen(f, codigos));
  }

  async findOne(id: string): Promise<DailyChecklistDetail> {
    return this.detalle(await this.cargar(id));
  }

  /**
   * Recibe el checklist completo y lo deja enviado al supervisor. Idempotente
   * por el id del cliente: un reenvío sin señal devuelve el mismo checklist.
   */
  submit(
    dto: SubmitDailyChecklistDto,
    editor: Editor,
  ): Promise<DailyChecklistDetail> {
    return createOrReturn({
      id: dto.id,
      userId: editor.id,
      conflictMessage: 'Ya existe un checklist con ese id de otro usuario',
      findExisting: async (id) => {
        const existente = await this.prisma.dailyChecklist.findUnique({
          where: { id },
          select: { createdById: true },
        });
        if (!existente) return null;
        return {
          ownerId: existente.createdById,
          result: () => this.findOne(id),
        };
      },
      create: () => this.crear(dto, editor),
    });
  }

  /**
   * El mantenedor corrige un checklist rechazado y lo reenvía: se reemplaza
   * lo declarado, los insumos del envío anterior vuelven a la bodega y se
   * descuentan los nuevos, y queda otra vez por validar.
   */
  async resubmit(
    id: string,
    dto: ResubmitDailyChecklistDto,
    editor: Editor,
  ): Promise<DailyChecklistDetail> {
    const actual = await this.cargar(id);

    // Reintento sin señal de un reenvío que ya entró: se devuelve tal cual.
    if (
      actual.status === ChecklistStatus.SUBMITTED &&
      actual.submissionCount === dto.submission + 1 &&
      actual.mechanicId === editor.id
    ) {
      return this.detalle(actual);
    }
    if (actual.status !== ChecklistStatus.REJECTED) {
      throw new ConflictException(
        actual.status === ChecklistStatus.ACCEPTED
          ? 'Este checklist ya fue aceptado: no se puede corregir.'
          : 'Este checklist está por validar: solo se corrige si el supervisor lo rechaza.',
      );
    }
    if (actual.submissionCount !== dto.submission) {
      throw new ConflictException(
        'El checklist cambió mientras lo corregías. Vuelve a abrirlo.',
      );
    }

    // El horómetro que ya se había enviado se acepta tal cual: entre la
    // colación y la corrección la lectura del equipo pudo subir al cerrar el
    // turno. Si lo cambian, vale contra la lectura de ahora.
    const equipo = await this.equipoConContador(
      actual.equipmentId,
      dto.counter,
      actual.counter,
    );
    const preparadas = await this.prepararEntradas(dto.entries, dto.branchId);

    const anteriores = new Map(
      actual.entries.map((e) => [e.itemId ?? e.id, e.photoKeys]),
    );
    const { fotosPorItem, reclamadas } = await this.reclamarFotos(
      dto.entries,
      editor,
      anteriores,
    );
    const conservadas = new Set([...fotosPorItem.values()].flat());
    const sobrantes = actual.entries
      .flatMap((e) => e.photoKeys)
      .filter((k) => !conservadas.has(k));

    const events: PendingStockEvents = [];
    let guardado: ChecklistCompleto;
    try {
      guardado = await this.prisma.$transaction(async (tx) => {
        // Solo si sigue rechazado y en el mismo envío: un doble reenvío
        // concurrente no puede descontar los insumos dos veces.
        const { count } = await tx.dailyChecklist.updateMany({
          where: {
            id,
            status: ChecklistStatus.REJECTED,
            submissionCount: dto.submission,
          },
          data: {
            status: ChecklistStatus.SUBMITTED,
            submissionCount: { increment: 1 },
            submittedAt: new Date(),
            counter: dto.counter,
            mechanicId: editor.id,
            mechanicName: editor.name,
            branchId: preparadas.usaInsumos ? (dto.branchId ?? null) : null,
          },
        });
        if (count === 0) {
          throw new ConflictException(
            'El checklist cambió mientras lo corregías. Vuelve a abrirlo.',
          );
        }

        // Lo que salió del stock en el envío anterior vuelve a la bodega.
        for (const entrada of actual.entries) {
          const usados =
            (entrada.supplies as unknown as InsumoUsado[] | null) ?? [];
          for (const s of usados) {
            await this.stock.receive(
              {
                itemId: s.itemId,
                branchId: actual.branchId as string,
                quantity: s.quantity,
                reason: MovementReason.RETURN,
                performedById: editor.id,
                equipmentId: actual.equipmentId,
                reference: id,
              },
              { tx, events },
            );
          }
        }

        await tx.dailyChecklistEntry.deleteMany({ where: { checklistId: id } });
        await tx.dailyChecklistEntry.createMany({
          data: this.datosEntradas(dto.entries, preparadas, fotosPorItem).map(
            (e) => ({ ...e, checklistId: id }),
          ),
        });
        await this.descontar(
          tx,
          dto.entries,
          dto.branchId,
          editor,
          equipo,
          id,
          events,
        );
        return tx.dailyChecklist.findUniqueOrThrow({
          where: { id },
          include: CHECKLIST_INCLUDE,
        });
      });
    } catch (error) {
      await Promise.all(reclamadas.map((k) => this.storage.discard(k)));
      throw error;
    }

    // Las fotos que se quitaron al corregir, recién con todo confirmado.
    await Promise.all(sobrantes.map((k) => this.storage.discard(k)));
    this.stock.emitPending(events);
    this.avisarEnvio(guardado, equipo, editor);
    return this.detalle(guardado);
  }

  /**
   * El supervisor acepta (el equipo se libera) o rechaza con comentario (vuelve
   * al mantenedor). Queda la traza de quién y cuándo, y se avisa al mantenedor
   * y al administrador.
   */
  async review(
    id: string,
    dto: ReviewDailyChecklistDto,
    reviewer: Editor,
  ): Promise<DailyChecklistDetail> {
    const actual = await this.cargar(id);

    const previa = actual.reviews.find((r) => r.submission === dto.submission);
    if (previa) {
      // Reintento sin señal de la misma decisión: se devuelve tal cual.
      if (
        previa.decision === dto.decision &&
        previa.reviewerId === reviewer.id
      ) {
        return this.detalle(actual);
      }
      throw new ConflictException(
        `Este checklist ya lo ${previa.decision === ChecklistStatus.ACCEPTED ? 'aceptó' : 'rechazó'} ${previa.reviewerName}.`,
      );
    }
    if (
      actual.status !== ChecklistStatus.SUBMITTED ||
      actual.submissionCount !== dto.submission
    ) {
      throw new ConflictException(
        'El checklist cambió mientras lo revisabas. Vuelve a abrirlo.',
      );
    }

    const comentario = dto.comment?.trim() || null;
    if (dto.decision === 'REJECTED' && (comentario?.length ?? 0) < 3) {
      throw new BadRequestException(
        'Al rechazar, explica qué tiene que corregir el mantenedor.',
      );
    }

    const decision =
      dto.decision === 'ACCEPTED'
        ? ChecklistStatus.ACCEPTED
        : ChecklistStatus.REJECTED;
    const guardado = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.dailyChecklist.updateMany({
        where: {
          id,
          status: ChecklistStatus.SUBMITTED,
          submissionCount: dto.submission,
        },
        data: { status: decision },
      });
      if (count === 0) {
        throw new ConflictException(
          'El checklist cambió mientras lo revisabas. Vuelve a abrirlo.',
        );
      }
      await tx.dailyChecklistReview.create({
        data: {
          checklistId: id,
          decision,
          comment: comentario,
          reviewerId: reviewer.id,
          reviewerName: reviewer.name,
          submission: dto.submission,
        },
      });
      return tx.dailyChecklist.findUniqueOrThrow({
        where: { id },
        include: CHECKLIST_INCLUDE,
      });
    });

    const codigos = await this.codigos([guardado.equipmentId]);
    this.eventEmitter.emit(DOMAIN_EVENTS.CHECKLIST_REVIEWED, {
      checklistId: id,
      equipmentId: guardado.equipmentId,
      equipmentCode: codigos.get(guardado.equipmentId) ?? guardado.equipmentId,
      date: formatDateOnly(guardado.date),
      decision: dto.decision,
      comment: comentario,
      reviewerName: reviewer.name,
      mechanicId: guardado.mechanicId,
      mechanicName: guardado.mechanicName,
    } satisfies ChecklistReviewedEvent);
    return this.detalle(guardado);
  }

  private async crear(
    dto: SubmitDailyChecklistDto,
    editor: Editor,
  ): Promise<DailyChecklistDetail> {
    const equipo = await this.equipoConContador(dto.equipmentId, dto.counter);

    const fecha = parseDateOnlyUtc(dto.date);
    const hoy = parseDateOnlyUtc(todayInBusinessTimeZone(new Date()));
    const dias = Math.round((fecha.getTime() - hoy.getTime()) / MS_DIA);
    if (dias > 1 || dias < -MAX_DIAS_ATRAS) {
      throw new BadRequestException(
        `La fecha del checklist (${dto.date}) está fuera de rango: hasta ${MAX_DIAS_ATRAS} días atrás.`,
      );
    }

    const yaEnviado = await this.prisma.dailyChecklist.findUnique({
      where: { equipmentId_date: { equipmentId: equipo.id, date: fecha } },
      select: { id: true },
    });
    if (yaEnviado) {
      throw new ConflictException(
        `Ya se envió el checklist de ${equipo.internalCode} del ${dto.date}.`,
      );
    }

    const preparadas = await this.prepararEntradas(dto.entries, dto.branchId);
    const { fotosPorItem, reclamadas } = await this.reclamarFotos(
      dto.entries,
      editor,
    );

    const events: PendingStockEvents = [];
    let creado: ChecklistCompleto;
    try {
      creado = await this.prisma.$transaction(async (tx) => {
        const checklist = await tx.dailyChecklist.create({
          data: {
            ...(dto.id ? { id: dto.id } : {}),
            equipmentId: equipo.id,
            date: fecha,
            counter: dto.counter,
            mechanicId: editor.id,
            mechanicName: editor.name,
            createdById: editor.id,
            branchId: preparadas.usaInsumos ? (dto.branchId ?? null) : null,
            entries: {
              create: this.datosEntradas(dto.entries, preparadas, fotosPorItem),
            },
          },
          include: CHECKLIST_INCLUDE,
        });

        // Los insumos salen del stock en la misma transacción: si uno no
        // alcanza en la bodega, no se guarda nada.
        await this.descontar(
          tx,
          dto.entries,
          dto.branchId,
          editor,
          equipo,
          checklist.id,
          events,
        );
        return checklist;
      });
    } catch (error) {
      await Promise.all(reclamadas.map((k) => this.storage.discard(k)));
      throw error;
    }

    // Los avisos (stock bajo, supervisor) solo después de confirmar.
    this.stock.emitPending(events);
    this.avisarEnvio(creado, equipo, editor);
    return this.detalle(creado);
  }

  private async cargar(id: string): Promise<ChecklistCompleto> {
    const fila = await this.prisma.dailyChecklist.findUnique({
      where: { id },
      include: CHECKLIST_INCLUDE,
    });
    if (!fila) throw new NotFoundException('Checklist no encontrado');
    return fila;
  }

  /**
   * El equipo, y que el horómetro anotado no sea menor que su lectura.
   * `yaEnviado`: el que traía el checklist que se corrige, que se acepta igual.
   */
  private async equipoConContador(
    equipmentId: string,
    counter: number,
    yaEnviado?: number,
  ): Promise<Equipo> {
    const equipo = await this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: {
        id: true,
        internalCode: true,
        controlUnit: true,
        currentHourmeter: true,
        currentMileage: true,
      },
    });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');

    // El rango va acá y no en el DTO: sin horómetro el DTO responde un solo
    // mensaje («Anota el horómetro…») en vez de tres.
    if (counter < 0 || counter > 10_000_000) {
      throw new BadRequestException(
        'El horómetro u odómetro tiene que estar entre 0 y 10.000.000.',
      );
    }

    // No puede ser menor que la lectura con que partió el equipo: un número
    // más bajo es un error de tipeo. El checklist no actualiza esa lectura.
    const km = equipo.controlUnit === 'KM';
    const lectura = km ? equipo.currentMileage : equipo.currentHourmeter;
    if (lectura != null && counter < lectura && counter !== yaEnviado) {
      const unidad = km ? 'km' : 'h';
      throw new BadRequestException(
        `El ${km ? 'odómetro' : 'horómetro'} anotado (${formatNumber(counter)} ${unidad}) es menor que la lectura con que partió ${equipo.internalCode} (${formatNumber(lectura)} ${unidad}). Revisa el número.`,
      );
    }
    return { id: equipo.id, internalCode: equipo.internalCode };
  }

  /** Las reglas de la especificación y los insumos, sobre el catálogo vigente. */
  private async prepararEntradas(
    entries: DailyChecklistEntryDto[],
    branchId: string | undefined,
  ): Promise<EntradasPreparadas> {
    const catalogo = await this.items();
    const problemas = checklistProblems(
      catalogo,
      entries.map((e) => ({
        itemId: e.itemId,
        status: e.status,
        description: e.description,
        temperature: e.temperature,
        photoCount: e.photoKeys?.length ?? 0,
        supplyCount: e.supplies?.length ?? 0,
      })),
    );
    if (problemas.length > 0) {
      throw new BadRequestException(problemas.join(' '));
    }

    const usaInsumos = entries.some((e) => (e.supplies?.length ?? 0) > 0);
    if (usaInsumos && !branchId) {
      throw new BadRequestException(
        'Indica la bodega de la que salen los insumos.',
      );
    }
    const insumoIds = [
      ...new Set(
        entries.flatMap((e) => (e.supplies ?? []).map((s) => s.insumoId)),
      ),
    ];
    const insumos = insumoIds.length
      ? await this.prisma.inventoryItem.findMany({
          where: { id: { in: insumoIds } },
          select: { id: true, sku: true, name: true },
        })
      : [];
    const insumoPorId = new Map(insumos.map((i) => [i.id, i]));
    if (insumoIds.some((id) => !insumoPorId.has(id))) {
      throw new BadRequestException(
        'Uno de los insumos ya no existe en el inventario.',
      );
    }
    return { catalogo, insumoPorId, usaInsumos };
  }

  /**
   * Las fotos se reclaman ANTES de la transacción (mismo criterio que el
   * taller): si la escritura falla, se descartan. Al corregir, una foto que el
   * ítem ya tenía viene por su id y se conserva.
   */
  private async reclamarFotos(
    entries: DailyChecklistEntryDto[],
    editor: Editor,
    anteriores: Map<string, string[]> = new Map(),
  ): Promise<{ fotosPorItem: Map<string, string[]>; reclamadas: string[] }> {
    const reclamadas: string[] = [];
    const fotosPorItem = new Map<string, string[]>();
    try {
      for (const entrada of entries) {
        if (entrada.status === 'NOT_CHECKED') continue;
        const finales: string[] = [];
        for (const key of entrada.photoKeys ?? []) {
          if (key.startsWith('tmp/')) {
            const final = await this.storage.claimTmp(
              key,
              editor.id,
              'checklist-photo',
            );
            reclamadas.push(final);
            finales.push(final);
            continue;
          }
          const conservada = (anteriores.get(entrada.itemId) ?? []).find(
            (k) => idDeFoto(k) === key,
          );
          if (!conservada) {
            throw new BadRequestException(
              'Una de las fotos ya no está en el checklist. Vuelve a abrirlo.',
            );
          }
          finales.push(conservada);
        }
        fotosPorItem.set(entrada.itemId, finales);
      }
    } catch (error) {
      await Promise.all(reclamadas.map((k) => this.storage.discard(k)));
      throw error;
    }
    return { fotosPorItem, reclamadas };
  }

  private datosEntradas(
    entries: DailyChecklistEntryDto[],
    { catalogo, insumoPorId }: EntradasPreparadas,
    fotosPorItem: Map<string, string[]>,
  ) {
    const posicion = new Map(catalogo.map((i) => [i.id, i]));
    return entries.map((e) => {
      const item = posicion.get(e.itemId)!;
      const declarado = e.status !== 'NOT_CHECKED';
      const usados: InsumoUsado[] =
        e.status === 'MAINTAINED'
          ? (e.supplies ?? []).map((s) => ({
              itemId: s.insumoId,
              sku: insumoPorId.get(s.insumoId)!.sku,
              name: insumoPorId.get(s.insumoId)!.name,
              quantity: s.cantidad,
            }))
          : [];
      return {
        itemId: item.id,
        itemName: item.name,
        position: item.position,
        status: e.status,
        description:
          e.status === 'MAINTAINED' ? (e.description?.trim() ?? null) : null,
        note: declarado ? e.note?.trim() || null : null,
        temperature: declarado ? (e.temperature ?? null) : null,
        photoKeys: fotosPorItem.get(e.itemId) ?? [],
        supplies: usados.length
          ? (usados as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      };
    });
  }

  /** Los insumos de las mantenciones salen de la bodega (salida INTERVENTION). */
  private async descontar(
    tx: Prisma.TransactionClient,
    entries: DailyChecklistEntryDto[],
    branchId: string | undefined,
    editor: Editor,
    equipo: Equipo,
    checklistId: string,
    events: PendingStockEvents,
  ): Promise<void> {
    for (const entrada of entries) {
      if (entrada.status !== 'MAINTAINED') continue;
      for (const s of entrada.supplies ?? []) {
        await this.stock.issue(
          {
            itemId: s.insumoId,
            branchId: branchId as string,
            quantity: s.cantidad,
            reason: MovementReason.INTERVENTION,
            performedById: editor.id,
            equipmentId: equipo.id,
            reference: checklistId,
          },
          { tx, events },
        );
      }
    }
  }

  private avisarEnvio(
    c: ChecklistCompleto,
    equipo: Equipo,
    editor: Editor,
  ): void {
    const cuenta = this.cuenta(c);
    this.eventEmitter.emit(DOMAIN_EVENTS.CHECKLIST_SUBMITTED, {
      checklistId: c.id,
      equipmentId: equipo.id,
      equipmentCode: equipo.internalCode,
      mechanicName: editor.name,
      date: formatDateOnly(c.date),
      declared: cuenta.declared,
      maintained: cuenta.maintained,
      photos: cuenta.photos,
      submission: c.submissionCount,
    } satisfies ChecklistSubmittedEvent);
  }

  private async codigos(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const equipos = await this.prisma.equipment.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, internalCode: true },
    });
    return new Map(equipos.map((e) => [e.id, e.internalCode]));
  }

  private cuenta(c: ChecklistCompleto) {
    return tally(
      c.entries.map((e) => ({
        itemId: e.itemId ?? e.id,
        status: e.status,
        photoCount: e.photoKeys.length,
        supplyCount: 0,
      })),
    );
  }

  private revision(
    r: ChecklistCompleto['reviews'][number],
  ): ChecklistReviewView {
    return {
      decision:
        r.decision === ChecklistStatus.ACCEPTED ? 'ACCEPTED' : 'REJECTED',
      comment: r.comment,
      reviewerName: r.reviewerName,
      submission: r.submission,
      createdAt: r.createdAt,
    };
  }

  private resumen(
    c: ChecklistCompleto,
    codigos: Map<string, string>,
  ): DailyChecklistSummary {
    const { declared, maintained, photos } = this.cuenta(c);
    const ultima = c.reviews.at(-1);
    return {
      id: c.id,
      equipment: {
        id: c.equipmentId,
        internalCode: codigos.get(c.equipmentId) ?? c.equipmentId,
      },
      date: formatDateOnly(c.date),
      counter: c.counter,
      status: c.status,
      mechanicName: c.mechanicName,
      submittedAt: c.submittedAt,
      submissionCount: c.submissionCount,
      declared,
      maintained,
      photos,
      lastReview: ultima ? this.revision(ultima) : null,
    };
  }

  private async detalle(c: ChecklistCompleto): Promise<DailyChecklistDetail> {
    const codigos = await this.codigos([c.equipmentId]);
    return {
      ...this.resumen(c, codigos),
      entries: await Promise.all(
        c.entries.map(async (e) => ({
          itemId: e.itemId,
          itemName: e.itemName,
          status: e.status,
          description: e.description,
          note: e.note,
          temperature: e.temperature,
          photos: await Promise.all(
            e.photoKeys.map(async (k) => ({
              id: idDeFoto(k),
              url: await this.storage.sign(k),
            })),
          ),
          supplies: (e.supplies as unknown as InsumoUsado[] | null) ?? [],
        })),
      ),
      reviews: c.reviews.map((r) => this.revision(r)),
    };
  }
}
