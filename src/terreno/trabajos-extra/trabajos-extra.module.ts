import { Module } from '@nestjs/common';
import { TrabajosExtraController } from './trabajos-extra.controller';
import { TrabajosExtraService } from './trabajos-extra.service';

@Module({ controllers: [TrabajosExtraController], providers: [TrabajosExtraService] })
export class TrabajosExtraModule {}
