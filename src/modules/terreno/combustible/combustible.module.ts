import { Module } from '@nestjs/common';
import { CombustibleController } from './combustible.controller';
import { CombustibleService } from './combustible.service';

@Module({ controllers: [CombustibleController], providers: [CombustibleService] })
export class CombustibleModule {}
