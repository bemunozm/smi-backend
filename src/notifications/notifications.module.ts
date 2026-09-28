import { Module } from '@nestjs/common';

import { MailModule } from '../mail/mail.module';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsListener } from './notifications.listener';
import { NotificationsService } from './notifications.service';

@Module({
  // StorageModule: el listener de `shift.exit-report` baja el PDF del
  // reporte (`StorageService.getObjectBuffer`) para adjuntarlo al correo —
  // ver Diseño del RFC Supervisión en Terreno §Reporte.
  imports: [MailModule, StorageModule, UsersModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsListener],
})
export class NotificationsModule {}
