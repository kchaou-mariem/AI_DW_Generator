import { Controller, Get, Param } from '@nestjs/common';
import { AiService } from './ai.service';

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Get('schema/:database')
  async generateSchema(@Param('database') database: string) {
    return this.aiService.generateSchema(database);
  }
}