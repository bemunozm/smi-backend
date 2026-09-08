import { Module } from '@nestjs/common';

import { MailModule } from '../mail/mail.module';
import { UsersModule } from '../users/users.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsListener } from './notifications.listener';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [MailModule, UsersModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsListener],
})
export class NotificationsModule {}
