import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setGlobalDispatcher, Agent } from 'undici';

setGlobalDispatcher(
  new Agent({
    headersTimeout: 600000,
    bodyTimeout: 600000,
  }),
);

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: 'http://localhost:4200',
  });
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();