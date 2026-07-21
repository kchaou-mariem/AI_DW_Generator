import { Module } from '@nestjs/common';
import { UploadModule } from '../upload/upload.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';

@Module({
  imports: [UploadModule],
  controllers: [AiController],
  providers: [AiService],
})
export class AiModule {}