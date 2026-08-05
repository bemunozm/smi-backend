import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('returns { data: { status: "ok" }, message: "ok" }', () => {
    expect(controller.check()).toEqual({
      data: { status: 'ok' },
      message: 'ok',
    });
  });
});
