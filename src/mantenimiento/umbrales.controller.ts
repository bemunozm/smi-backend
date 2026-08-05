import { Body, Controller, Get, Post } from '@nestjs/common';
import { Roles } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../auth/roles';
import { CreateUmbralDto } from './dto/create-umbral.dto';
import type { UmbralResponseDto } from './dto/umbral-response.dto';
import { UmbralesService } from './umbrales.service';

interface UmbralListResponse {
  data: UmbralResponseDto[];
  message: string;
}

interface UmbralDetailResponse {
  data: UmbralResponseDto;
  message: string;
}

@Controller('mantenimiento/umbrales')
export class UmbralesController {
  constructor(private readonly umbralesService: UmbralesService) {}

  @Get()
  @Roles([ROLES.ADMIN, ROLES.MANTENEDOR])
  async findAll(): Promise<UmbralListResponse> {
    const data = await this.umbralesService.findAll();
    return { data, message: 'ok' };
  }

  @Post()
  @Roles([ROLES.ADMIN])
  async create(@Body() dto: CreateUmbralDto): Promise<UmbralDetailResponse> {
    const data = await this.umbralesService.create(dto);
    return { data, message: 'Umbral creado' };
  }
}
