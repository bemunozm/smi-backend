import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { EquiposModule } from './modules/equipos/equipos.module';

@Module({
  imports: [PrismaModule, CommonModule, EquiposModule],
})
export class AppModule {}
