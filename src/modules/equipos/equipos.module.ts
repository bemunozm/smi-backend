import { Module } from '@nestjs/common';
import { EquiposController } from './equipos.controller';

@Module({ controllers: [EquiposController] })
export class EquiposModule {}
