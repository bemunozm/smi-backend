import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('HealthController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  it('/api/health (GET) is public and returns {data,message}', () => {
    return request(app.getHttpServer())
      .get('/api/health')
      .expect(200)
      .expect({ data: { status: 'ok' }, message: 'ok' });
  });

  afterEach(async () => {
    await app.close();
  });
});
