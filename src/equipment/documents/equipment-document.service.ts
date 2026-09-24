import { Injectable, NotFoundException } from '@nestjs/common';
import type { EquipmentDocument, EquipmentDocumentType } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { buildDocumentExpiryInfo, DocumentStatus } from '../document-expiry';
import { CreateEquipmentDocumentDto } from './dto/create-equipment-document.dto';
import { UpdateEquipmentDocumentDto } from './dto/update-equipment-document.dto';

/** Forma de un documento en la API — el registro crudo de Prisma más su
 * vigencia derivada on-read (`status`/`daysToExpiry`, via `buildDocumentExpiryInfo`).
 * NUNCA expone `fileKey` — solo `fileUrl` firmada on-read (ver Diseño del
 * RFC R2-storage, "Contrato de la API"). */
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
    await this.assertEquipmentExists(equipmentId);

    const { fileKey, ...rest } = dto;
    const finalKey = fileKey
      ? await this.storage.claimTmp(fileKey, userId, 'equipment-document')
      : undefined;

    // El `try/catch` cubre SOLO la escritura en Prisma (hallazgo BAJO B1 de
    // la revisión de seguridad, mismo patrón que `EquipmentService.create`):
    // antes acá `return this.shape(document)` SIN `await` dentro del try
    // hacía que el rollback nunca se disparara igual por accidente (la
    // promesa rechazada del `shape` escapaba el try antes de asentarse) —
    // se deja explícito para no depender de ese detalle.
    let document: EquipmentDocument;
    try {
      document = await this.prisma.equipmentDocument.create({
        data: { equipmentId, ...rest, fileKey: finalKey },
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
   * `fileKey` es tri-state (chequeado con `=== undefined`, ver Diseño del
   * RFC R2-storage): omitido deja el archivo intacto, `null` lo borra, un
   * string reclama una key `tmp/` nueva. El objeto viejo se borra
   * best-effort DESPUÉS de que la escritura en la BD ya se confirmó.
   */
  async update(
    id: string,
    dto: UpdateEquipmentDocumentDto,
    userId: string,
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

    // Mismo criterio que `create` (hallazgo BAJO B1): el `try/catch` cubre
    // SOLO la escritura en Prisma. El borrado del archivo viejo y el shaping
    // van DESPUÉS, fuera del try.
    let document: EquipmentDocument;
    try {
      document = await this.prisma.equipmentDocument.update({
        where: { id },
        data: finalKey !== undefined ? { ...rest, fileKey: finalKey } : rest,
      });
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
