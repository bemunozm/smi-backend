import { Injectable, NotFoundException } from '@nestjs/common';
import type { EquipmentDocument, EquipmentDocumentType } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { buildDocumentExpiryInfo, DocumentStatus } from '../document-expiry';
import { CreateEquipmentDocumentDto } from './dto/create-equipment-document.dto';
import { UpdateEquipmentDocumentDto } from './dto/update-equipment-document.dto';

/** Forma de un documento en la API — el registro crudo de Prisma más su
 * vigencia derivada on-read (`status`/`daysToExpiry`, via `buildDocumentExpiryInfo`). */
export interface EquipmentDocumentResponse {
  id: string;
  equipmentId: string;
  type: EquipmentDocumentType;
  title: string | null;
  /** ISO 8601, o `null` si no hay vencimiento cargado. */
  expiryDate: string | null;
  fileUrl: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  status: DocumentStatus;
  daysToExpiry: number | null;
}

@Injectable()
export class EquipmentDocumentService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Crea un documento del equipo. Valida que el equipo exista primero: sin
   * este chequeo, Prisma fallaría con un P2003 (FK inválida) que el caller
   * tendría que mapear a mano — acá se anticipa con un 404 legible.
   */
  async create(
    equipmentId: string,
    dto: CreateEquipmentDocumentDto,
  ): Promise<EquipmentDocumentResponse> {
    await this.assertEquipmentExists(equipmentId);

    const document = await this.prisma.equipmentDocument.create({
      data: { equipmentId, ...dto },
    });

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

    return documents.map((document) => this.shape(document));
  }

  async update(
    id: string,
    dto: UpdateEquipmentDocumentDto,
  ): Promise<EquipmentDocumentResponse> {
    await this.findOrThrow(id);

    const document = await this.prisma.equipmentDocument.update({
      where: { id },
      data: dto,
    });

    return this.shape(document);
  }

  async remove(id: string): Promise<void> {
    // Solo se borra el registro de la BD — la limpieza del archivo en disco
    // (`fileUrl`, servido por `/api/uploads`) queda como follow-up, mismo
    // criterio que el resto de la app (ningún dominio borra archivos hoy).
    await this.findOrThrow(id);
    await this.prisma.equipmentDocument.delete({ where: { id } });
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

  private shape(document: EquipmentDocument): EquipmentDocumentResponse {
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
      fileUrl: document.fileUrl,
      notes: document.notes,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      status,
      daysToExpiry,
    };
  }
}
