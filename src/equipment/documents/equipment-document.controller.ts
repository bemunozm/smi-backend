import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Roles } from '@thallesp/nestjs-better-auth';

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
  ) {
    assertNonEmptyId(equipmentId, 'equipmentId');
    return {
      data: await this.service.create(equipmentId, dto),
      message: 'Documento creado',
    };
  }

  @Patch('documents/:id')
  @Roles([ROLES.SUPERVISOR, ROLES.ADMIN])
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateEquipmentDocumentDto,
  ) {
    assertNonEmptyId(id);
    return {
      data: await this.service.update(id, dto),
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
}
