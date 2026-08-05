import { Module } from '@nestjs/common';
import { HallazgosController } from './hallazgos.controller';
import { HallazgosService } from './hallazgos.service';

@Module({ controllers: [HallazgosController], providers: [HallazgosService] })
export class HallazgosModule {}
