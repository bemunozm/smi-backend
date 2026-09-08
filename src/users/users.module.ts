import { Module } from '@nestjs/common';

import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService],
  // Exportado para que NotificationsModule (Núcleo) resuelva destinatarios
  // por rol vía `findByRole` en el fan-out de notificaciones.
  exports: [UsersService],
})
export class UsersModule {}
