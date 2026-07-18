import { Module } from '@nestjs/common';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { TypeOrmModule } from '@nestjs/typeorm';

@Module({
  imports: [TypeOrmModule], // ← ajouté
  controllers: [UploadController],
  providers: [UploadService],
})
export class UploadModule {}