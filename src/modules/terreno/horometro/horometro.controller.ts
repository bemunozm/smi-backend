import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { HorometroService } from './horometro.service';
import { CreateHorometroDto } from './dto/create-horometro.dto';
import { UpdateHorometroDto } from './dto/update-horometro.dto';
import { Roles } from '../../../common/decorators/roles.decorator';

@Controller('horometro')
export class HorometroController {
  constructor(private readonly service: HorometroService) {}

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
  create(@Body() dto: CreateHorometroDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles('SUPERVISOR', 'ADMIN')
  update(@Param('id') id: string, @Body() dto: UpdateHorometroDto) {
    return this.service.update(id, dto);
  }
}
