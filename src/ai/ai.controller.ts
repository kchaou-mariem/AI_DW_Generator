import { Controller, Get, Post, Body, Param, NotFoundException } from '@nestjs/common';
import { AiService } from './ai.service';
import { UploadService } from '../upload/upload.service';

@Controller('ai')
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly uploadService: UploadService,
  ) {}

  @Get('schema/:database')
  async generateSchema(@Param('database') database: string) {
    return this.aiService.generateSchema(database);
  }

  @Post('schema/:database/validate')
  async validateSchema(@Param('database') database: string, @Body() body: unknown) {
    return this.uploadService.saveSchemaValidation(database, body);
  }

  @Get('schema/:database/validate')
  async getValidatedSchema(@Param('database') database: string) {
    const result = await this.uploadService.getLatestSchemaValidation(database);
    if (!result) {
      throw new NotFoundException(`Aucun schéma validé trouvé pour ${database}`);
    }
    return result;
  }
}