import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';

@Module({
  imports: [ConfigModule],//on n a plus besoin de TypeOrmModule car on utilise le service UploadService pour se connecter à la base de données
  controllers: [UploadController],
  providers: [UploadService],
})
export class UploadModule {}