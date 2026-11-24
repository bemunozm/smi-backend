import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../auth/roles';
import { ExpectedFields } from '../common/concurrency/expected-fields.decorator';
import type { ExpectedValues } from '../common/concurrency/expected-fields';
import { assertCierreSecretariaSinInsumos } from './common/assert-cierre-secretaria';
import { assertNonEmptyId } from './common/assert-non-empty-id';
import { CreateMantencionHistoricaDto } from './dto/create-mantencion-historica.dto';
import { CreateOrdenDto } from './dto/create-orden.dto';
import { DeleteOrdenQueryDto } from './dto/delete-orden-query.dto';
import { FinalizarOrdenDto } from './dto/finalizar-orden.dto';
import { FindOrdenesQueryDto } from './dto/find-ordenes-query.dto';
import type { OrdenFinalizadaResponseDto } from './dto/orden-finalizada-response.dto';
import type { OrdenResponseDto } from './dto/orden-response.dto';
import type { TareaResponseDto } from './dto/tarea-response.dto';
import { ToggleTareaDto } from './dto/toggle-tarea.dto';
import { UpdateOrdenDto } from './dto/update-orden.dto';
import { OrdenesService } from './ordenes.service';

interface OrdenListResponse {
  data: OrdenResponseDto[];
  message: string;
}

interface OrdenDetailResponse {
  data: OrdenResponseDto;
  message: string;
}

interface OrdenFinalizadaResponse {
  data: OrdenFinalizadaResponseDto;
  message: string;
}

interface TareaDetailResponse {
  data: TareaResponseDto;
  message: string;
}

@Controller('mantenimiento/ordenes')
export class OrdenesController {
  constructor(private readonly ordenesService: OrdenesService) {}

  @Get()
  @Roles([ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.MANTENEDOR, ROLES.SECRETARIA])
  async findAll(
    @Query() query: FindOrdenesQueryDto,
  ): Promise<OrdenListResponse> {
    const data = await this.ordenesService.findAll(query.estado);
    return { data, message: 'ok' };
  }

  @Get(':id')
  @Roles([ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.MANTENEDOR, ROLES.SECRETARIA])
  async findOne(@Param('id') id: string): Promise<OrdenDetailResponse> {
    assertNonEmptyId(id);
    const data = await this.ordenesService.findOne(id);
    return { data, message: 'ok' };
  }

  // MANTENEDOR incluido: el taller inicia operaciones desde los hallazgos de
  // su bandeja (la orden nace ligada al hallazgo y lo pasa a EN_PROCESO).
  @Post()
  @Roles([ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.MANTENEDOR])
  async create(
    @Body() dto: CreateOrdenDto,
    @Session() session: UserSession,
  ): Promise<OrdenDetailResponse> {
    const data = await this.ordenesService.create(dto, session.user.id);
    return { data, message: 'Orden de trabajo creada' };
  }

  // Solo ADMIN: es carga de datos (historia previa de equipos antiguos), no
  // operación del taller. Va ANTES de `@Get(':id')` en la URL pero como POST
  // no choca con esa ruta.
  @Post('historica')
  @Roles([ROLES.ADMIN])
  async createHistorica(
    @Body() dto: CreateMantencionHistoricaDto,
    @Session() session: UserSession,
  ): Promise<OrdenDetailResponse> {
    const data = await this.ordenesService.createHistorica(
      dto,
      session.user.id,
    );
    return { data, message: 'Mantención anterior registrada' };
  }

  // SECRETARIA: cierra (o corrige) una orden que el taller dejó en proceso.
  @Patch(':id')
  @Roles([ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.MANTENEDOR, ROLES.SECRETARIA])
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateOrdenDto,
    @Session() session: UserSession,
    @ExpectedFields() expected?: ExpectedValues,
  ): Promise<OrdenDetailResponse> {
    assertNonEmptyId(id);
    // El editor firma el registro del servicio de un liviano al completar.
    const data = await this.ordenesService.update(
      id,
      dto,
      { id: session.user.id, name: session.user.name },
      expected,
    );
    return { data, message: 'Orden de trabajo actualizada' };
  }

  /**
   * «Finalizar tarea» atómico: la intervención del cierre (insumos, foto) y
   * la orden COMPLETADA (ancla de la pizarra, estado del equipo) en una sola
   * transacción. Reemplaza al POST de la intervención + PATCH de la orden,
   * que dejaban la intervención y el stock escritos si el PATCH se rechazaba
   * (esos dos endpoints siguen vigentes para los clientes ya desplegados).
   *
   * Roles: los que pueden registrar una intervención Y cerrar la orden.
   * SECRETARIA cierra sin insumos, igual que en la intervención suelta.
   */
  @Post(':id/finalizar')
  @Roles([ROLES.ADMIN, ROLES.MANTENEDOR, ROLES.SECRETARIA])
  async finalizar(
    @Param('id') id: string,
    @Body() dto: FinalizarOrdenDto,
    @Session() session: UserSession,
  ): Promise<OrdenFinalizadaResponse> {
    assertNonEmptyId(id);
    assertCierreSecretariaSinInsumos(session.user.role, dto);
    const data = await this.ordenesService.finalizar(id, dto, {
      id: session.user.id,
      name: session.user.name,
    });
    return { data, message: 'Operación finalizada' };
  }

  /**
   * Borra una operación pendiente o en proceso (las finalizadas son
   * historial). Con `yaHecha=true` una preventiva de la pauta queda
   * registrada como hecha antes de borrarla.
   */
  @Delete(':id')
  @Roles([ROLES.ADMIN, ROLES.MANTENEDOR])
  async remove(
    @Param('id') id: string,
    @Query() query: DeleteOrdenQueryDto,
    @Session() session: UserSession,
  ): Promise<{ data: { registradaComoHecha: boolean }; message: string }> {
    assertNonEmptyId(id);
    const data = await this.ordenesService.remove(id, query, {
      id: session.user.id,
      name: session.user.name,
    });
    return {
      data,
      message: data.registradaComoHecha
        ? 'Mantención registrada como hecha y operación eliminada'
        : 'Operación eliminada',
    };
  }

  @Patch(':ordenId/tareas/:tareaId')
  @Roles([ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.MANTENEDOR])
  async toggleTarea(
    @Param('ordenId') ordenId: string,
    @Param('tareaId') tareaId: string,
    @Body() dto: ToggleTareaDto,
    @Session() session: UserSession,
  ): Promise<TareaDetailResponse> {
    assertNonEmptyId(ordenId, 'ordenId');
    assertNonEmptyId(tareaId, 'tareaId');
    const data = await this.ordenesService.updateTarea(ordenId, tareaId, dto, {
      id: session.user.id,
      name: session.user.name,
    });
    return { data, message: 'Tarea actualizada' };
  }
}
