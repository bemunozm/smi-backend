import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { CombustibleService } from './combustible.service';
import { CreateCombustibleDto } from './dto/create-combustible.dto';
import { UpdateCombustibleDto } from './dto/update-combustible.dto';
import { Roles } from '../../../common/decorators/roles.decorator';

@Controller('combustible')
export class CombustibleController {
  constructor(private readonly service: CombustibleService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles('SUPERVISOR', 'ADMIN')
  create(@Body() dto: CreateCombustibleDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles('SUPERVISOR', 'ADMIN')
  update(@Param('id') id: string, @Body() dto: UpdateCombustibleDto) {
    return this.service.update(id, dto);
  }
}
