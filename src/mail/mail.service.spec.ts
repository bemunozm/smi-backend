import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

jest.mock('../common/config/env', () => ({
  env: {
    smtpHost: undefined,
    smtpPort: undefined,
    smtpUser: undefined,
    smtpPass: undefined,
    smtpFrom: undefined,
    smtpSecure: false,
  },
}));

import { MailService } from './mail.service';

describe('MailService', () => {
  let service: MailService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MailService],
    }).compile();

    service = module.get<MailService>(MailService);
  });

  it('sin SMTP configurado, sendMail es no-op y no lanza', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    await expect(
      service.sendMail({
        to: 'destino@smi.local',
        subject: 'Asunto',
        html: '<p>hola</p>',
      }),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith('email disabled: SMTP not configured');
    warnSpy.mockRestore();
  });

  it('solo resuelve el transport una vez (cachea el resultado no-op)', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    await service.sendMail({
      to: 'a@smi.local',
      subject: 'x',
      html: '<p>x</p>',
    });
    await service.sendMail({
      to: 'b@smi.local',
      subject: 'y',
      html: '<p>y</p>',
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
