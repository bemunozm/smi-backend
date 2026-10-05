import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  EquipmentDocument,
  EquipmentDocumentType,
  Prisma,
} from '@prisma/client';

import {
  assertExpectedLocked,
  definedFields,
} from '../../common/concurrency/assert-expected-locked';
import type { ExpectedValues } from '../../common/concurrency/expected-fields';
import { createOrReturn } from '../../common/idempotency/create-or-return';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { buildDocumentExpiryInfo, DocumentStatus } from '../document-expiry';
import { CreateEquipmentDocumentDto } from './dto/create-equipment-document.dto';
import { UpdateEquipmentDocumentDto } from './dto/update-equipment-document.dto';

/** Forma de un documento en la API — el registro crudo de Prisma más su
 * vigencia derivada on-read (`status`/`daysToExpiry`, via `buildDocumentExpiryInfo`).
 * NUNCA expone `fileKey` — solo `fileUrl` firmada on-read. */
export interface EquipmentDocumentResponse {
  id: string;
  equipmentId: string;
  type: EquipmentDocumentType;
  title: string | null;
  /** ISO 8601, o `null` si no hay vencimiento cargado. */
  expiryDate: string | null;
  fileUrl: string | null;
  /** Nombre "humano" del archivo (el que subió el usuario). */
  fileName: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  status: DocumentStatus;
  daysToExpiry: number | null;
}

/** Cómo se nombra cada dato en el mensaje de conflicto (`STALE_UPDATE`).
 * `fileKey` no entra: reemplazar el archivo es última-escritura-gana. */
const CAMPO_LABEL: Record<string, string> = {
  type: 'Tipo',
  title: 'Título',
  expiryDate: 'Vencimiento',
  fileName: 'Nombre del archivo',
  notes: 'Notas',
};

const UPDATE_FIELDS = {
  type: true,
  title: true,
  expiryDate: true,
  fileName: true,
  notes: true,
} as const;

/** El vencimiento viaja como texto ISO (o fecha sola): se compara como
 * instante, igual que lo deja Postgres. */
function withExpiryAsInstant(
  values: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!values || typeof values.expiryDate !== 'string') return values;
  const parsed = new Date(values.expiryDate);
  if (Number.isNaN(parsed.getTime())) return values;
  return { ...values, expiryDate: parsed };
}

@Injectable()
export class EquipmentDocumentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Crea un documento del equipo. Valida que el equipo exista primero: sin
   * este chequeo, Prisma fallaría con un P2003 (FK inválida) que el caller
   * tendría que mapear a mano — acá se anticipa con un 404 legible.
   *
   * `fileKey` se reclama ANTES del `create` (fuera del try) — igual que
   * `EquipmentService.create`: si el claim falla, no hay nada que revertir.
   */
  async create(
    equipmentId: string,
    dto: CreateEquipmentDocumentDto,
    userId: string,
  ): Promise<EquipmentDocumentResponse> {
    return createOrReturn({
      id: dto.id,
      userId,
      conflictMessage: 'Ya existe un documento con ese id de otro usuario',
      // El reintento propio devuelve el documento con su archivo firmado de
      // nuevo; no reclama la key tmp ni toca nada.
      findExisting: async (id) => {
        const document = await this.prisma.equipmentDocument.findUnique({
          where: { id },
          omit: { createdById: false },
        });
        if (!document) return null;
        return {
          ownerId: document.createdById,
          result: () => this.shape(document),
        };
      },
      create: () => this.createFresh(equipmentId, dto, userId),
    });
  }

  private async createFresh(
    equipmentId: string,
    dto: CreateEquipmentDocumentDto,
    userId: string,
  ): Promise<EquipmentDocumentResponse> {
    await this.assertEquipmentExists(equipmentId);

    const { id, fileKey, ...rest } = dto;
    const finalKey = fileKey
      ? await this.storage.claimTmp(fileKey, userId, 'equipment-document')
      : undefined;

    // El `try/catch` cubre SOLO la escritura en Prisma (mismo patrón que
    // `EquipmentService.create`): el borrado del archivo viejo y el shaping
    // van después, fuera del try.
    let document: EquipmentDocument;
    try {
      document = await this.prisma.equipmentDocument.create({
        data: {
          ...(id ? { id } : {}),
          equipmentId,
          ...rest,
          fileKey: finalKey,
          createdById: userId,
        },
      });
    } catch (error: unknown) {
      if (finalKey) {
        await this.storage.discard(finalKey);
      }
      throw error;
    }

    return this.shape(document);
  }

  /** Documentos del equipo, más recientes primero. */
  async findByEquipment(
    equipmentId: string,
  ): Promise<EquipmentDocumentResponse[]> {
    await this.assertEquipmentExists(equipmentId);

    const documents = await this.prisma.equipmentDocument.findMany({
      where: { equipmentId },
      orderBy: { createdAt: 'desc' },
    });

    return Promise.all(documents.map((document) => this.shape(document)));
  }

  /**
   * `fileKey` es tri-state (chequeado con `=== undefined`, omitido deja el archivo intacto, `null` lo borra, un
   * string reclama una key `tmp/` nueva. El objeto viejo se borra
   * best-effort DESPUÉS de que la escritura en la BD ya se confirmó.
   */
  async update(
    id: string,
    dto: UpdateEquipmentDocumentDto,
    userId: string,
    expected?: ExpectedValues,
  ): Promise<EquipmentDocumentResponse> {
    const existente = await this.findOrThrow(id);
    const { fileKey, ...rest } = dto;

    let finalKey: string | null | undefined;
    if (fileKey === undefined) {
      finalKey = undefined;
    } else if (fileKey === null) {
      finalKey = null;
    } else {
      finalKey = await this.storage.claimTmp(
        fileKey,
        userId,
        'equipment-document',
      );
    }

    // Mismo criterio que `create`: el `try/catch` cubre
    // SOLO la escritura en Prisma. El borrado del archivo viejo y el shaping
    // van DESPUÉS, fuera del try.
    const write = (db: Prisma.TransactionClient) =>
      db.equipmentDocument.update({
        where: { id },
        data: finalKey !== undefined ? { ...rest, fileKey: finalKey } : rest,
      });

    let document: EquipmentDocument;
    try {
      document = expected
        ? await this.prisma.$transaction(async (tx) => {
            await assertExpectedLocked({
              tx,
              table: 'equipmentDocument',
              id,
              expected: withExpiryAsInstant(expected),
              read: (db) =>
                db.equipmentDocument.findUnique({
                  where: { id },
                  select: UPDATE_FIELDS,
                }),
              desired: withExpiryAsInstant(definedFields(rest)) ?? {},
              labels: CAMPO_LABEL,
              notFoundMessage: `Documento "${id}" no encontrado`,
            });
            return write(tx);
          })
        : await write(this.prisma);
    } catch (error: unknown) {
      if (typeof finalKey === 'string') {
        await this.storage.discard(finalKey);
      }
      throw error;
    }

    if (finalKey !== undefined && existente.fileKey) {
      await this.storage.deleteBestEffort(existente.fileKey);
    }

    return this.shape(document);
  }

  async remove(id: string): Promise<void> {
    const document = await this.findOrThrow(id);
    await this.prisma.equipmentDocument.delete({ where: { id } });
    if (document.fileKey) {
      await this.storage.deleteBestEffort(document.fileKey);
    }
  }

  /**
   * URL firmada RECIÉN generada para `GET /api/equipment/documents/:id/file`
   * (redirect 302) — a diferencia de la `fileUrl` que viaja en el listado
   * (que puede quedar vieja si la pestaña lleva horas abierta), esta siempre
   * es fresca. `null` si el documento no tiene archivo (el caller responde
   * 404).
   */
  async getSignedFileUrl(id: string): Promise<string | null> {
    const document = await this.findOrThrow(id);
    if (!document.fileKey) {
      return null;
    }
    return this.storage.sign(document.fileKey, {
      fileName: document.fileName ?? undefined,
    });
  }

  private async assertEquipmentExists(equipmentId: string): Promise<void> {
    const exists = await this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException(`Equipo "${equipmentId}" no encontrado`);
    }
  }

  private async findOrThrow(id: string): Promise<EquipmentDocument> {
    const document = await this.prisma.equipmentDocument.findUnique({
      where: { id },
    });
    if (!document) {
      throw new NotFoundException(`Documento "${id}" no encontrado`);
    }
    return document;
  }

  private async shape(
    document: EquipmentDocument,
  ): Promise<EquipmentDocumentResponse> {
    const { status, daysToExpiry } = buildDocumentExpiryInfo(
      document.expiryDate,
    );
    return {
      id: document.id,
      equipmentId: document.equipmentId,
      type: document.type,
      title: document.title,
      expiryDate: document.expiryDate
        ? document.expiryDate.toISOString()
        : null,
      fileUrl: document.fileKey
        ? await this.storage.sign(document.fileKey, {
            fileName: document.fileName ?? undefined,
          })
        : null,
      fileName: document.fileName,
      notes: document.notes,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      status,
      daysToExpiry,
    };
  }
}
