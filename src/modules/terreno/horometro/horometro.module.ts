import { Module } from '@nestjs/common';
import { HorometroController } from './horometro.controller';
import { HorometroService } from './horometro.service';

@Module({ controllers: [HorometroController], providers: [HorometroService] })
export class HorometroModule {}
