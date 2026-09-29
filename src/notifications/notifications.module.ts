import { Module } from '@nestjs/common';

import { MailModule } from '../mail/mail.module';
import { ShiftsModule } from '../shifts/shifts.module';
import { UsersModule } from '../users/users.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsListener } from './notifications.listener';
import { NotificationsService } from './notifications.service';

@Module({
  // ShiftsModule: el listener de `shift.exit-report` pide el adjunto del PDF
  // y marca `emailStatus` vía `ShiftReportsService` — nunca toca Prisma ni
  // storage directamente sobre un modelo que no le pertenece.
  imports: [MailModule, ShiftsModule, UsersModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsListener],
})
export class NotificationsModule {}
