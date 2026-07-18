import { Module } from '@nestjs/common';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';


@Module({
  imports: [TypeOrmModule,ConfigModule], // ← ajouté
  controllers: [UploadController],
  providers: [UploadService],
})
export class UploadModule {}