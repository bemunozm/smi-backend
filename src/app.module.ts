import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { EquiposModule } from './modules/equipos/equipos.module';
import { TerrenoModule } from './modules/terreno/terreno.module';

@Module({
  imports: [PrismaModule, CommonModule, EquiposModule, TerrenoModule],
})
export class AppModule {}
