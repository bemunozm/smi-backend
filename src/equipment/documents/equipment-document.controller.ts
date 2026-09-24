import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Redirect,
} from '@nestjs/common';
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../../auth/roles';
import { CreateEquipmentDocumentDto } from './dto/create-equipment-document.dto';
import { UpdateEquipmentDocumentDto } from './dto/update-equipment-document.dto';
import { EquipmentDocumentService } from './equipment-document.service';

function assertNonEmptyId(id: string, param = 'id'): void {
  if (!id || id.trim().length === 0) {
    throw new BadRequestException(
      `El parámetro "${param}" no puede estar vacío`,
    );
  }
}

/**
 * Documentos del equipo (revisión técnica, seguro, permiso de circulación,
 * certificaciones, otros), con archivo adjunto y CRUD propio — reemplaza las
 * columnas planas R1/R2 de la primera versión de Flota. Controller separado
 * de `EquipmentController` (mismo prefijo `equipment`, sin colisión de rutas:
 * ver métodos abajo), igual que `HorometroController` vive aparte de
 * `EquipmentController` para el dominio de Terreno.
 *
 * Lectura abierta a cualquier sesión autenticada (el `AuthGuard` global ya
 * exige sesión) — mismo criterio que `EquipmentController.findAll/findOne`.
 * Escritura restringida a SUPERVISOR/ADMIN, igual que `/api/uploads`.
 */
@Controller('equipment')
export class EquipmentDocumentController {
  constructor(private readonly service: EquipmentDocumentService) {}

  @Get(':equipmentId/documents')
  async findByEquipment(@Param('equipmentId') equipmentId: string) {
    assertNonEmptyId(equipmentId, 'equipmentId');
    return {
      data: await this.service.findByEquipment(equipmentId),
      message: 'ok',
    };
  }

  @Post(':equipmentId/documents')
  @Roles([ROLES.SUPERVISOR, ROLES.ADMIN])
  async create(
    @Param('equipmentId') equipmentId: string,
    @Body() dto: CreateEquipmentDocumentDto,
    @Session() session: UserSession,
  ) {
    assertNonEmptyId(equipmentId, 'equipmentId');
    return {
      data: await this.service.create(equipmentId, dto, session.user.id),
      message: 'Documento creado',
    };
  }

  @Patch('documents/:id')
  @Roles([ROLES.SUPERVISOR, ROLES.ADMIN])
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateEquipmentDocumentDto,
    @Session() session: UserSession,
  ) {
    assertNonEmptyId(id);
    return {
      data: await this.service.update(id, dto, session.user.id),
      message: 'Documento actualizado',
    };
  }

  @Delete('documents/:id')
  @Roles([ROLES.SUPERVISOR, ROLES.ADMIN])
  async remove(@Param('id') id: string) {
    assertNonEmptyId(id);
    await this.service.remove(id);
    return { data: { id }, message: 'Documento eliminado' };
  }

  /**
   * "Ver/descargar" del archivo adjunto: 302 a una URL RECIÉN firmada (no la
   * que viaja en el listado, que puede haber quedado vieja si la pestaña
   * lleva horas abierta) — ver Diseño del RFC R2-storage, "Contrato de la
   * API". Mismo acceso de lectura que `findByEquipment` (cualquier sesión
   * autenticada, sin `@Roles` propio). Los errores (404 sin archivo) siguen
   * el `{data,message}` del filtro global: `@Redirect()` solo intercepta el
   * `return`, no las excepciones.
   */
  @Get('documents/:id/file')
  @Redirect()
  async getFile(
    @Param('id') id: string,
  ): Promise<{ url: string; statusCode: number }> {
    assertNonEmptyId(id);
    const url = await this.service.getSignedFileUrl(id);
    if (!url) {
      throw new NotFoundException('El documento no tiene archivo adjunto');
    }
    return { url, statusCode: HttpStatus.FOUND };
  }
}
