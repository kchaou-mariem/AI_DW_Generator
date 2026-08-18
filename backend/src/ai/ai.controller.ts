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

  @Post('schema/:database/session')
async startSession(@Param('database') database: string) {
  const proposal = await this.aiService.generateSchema(database);
  const { sessionId } = await this.uploadService.initChatSession(database, proposal);
  return { sessionId, schema: proposal };
}

@Post('schema/:database/session/from-existing')
async startSessionFromExisting(
  @Param('database') database: string,
  @Body() existingSchema: unknown,
) {
  const { sessionId } = await this.uploadService.initChatSessionFromExisting(database, existingSchema);
  return { sessionId, schema: existingSchema };
}

@Post('schema/:database/session/:sessionId/chat')
async chatModifySchema(
  @Param('database') database: string,
  @Param('sessionId') sessionId: number,
  @Body('message') message: string,
  @Body('currentSchema') currentSchema: unknown,
) {
  let schemaToUse = currentSchema;
  if (!schemaToUse) {
    const history = await this.uploadService.getChatHistory(database, sessionId);
    schemaToUse = history[history.length - 1].schema; // fallback si rien n'est fourni
  }

  const result = await this.aiService.applyChatModification(database, schemaToUse, message);

  if (!result.schemaChanged) {
    // ✅ Simple question / aucune modification réelle : pas de nouvel état créé
    const history = await this.uploadService.getChatHistory(database, sessionId);
    const lastStepNumber = history.length > 0 ? history[history.length - 1].stepNumber : 0;

    return {
      stepNumber: lastStepNumber, // on renvoie le dernier step existant, inchangé
      schema: result.updatedSchema,
      explanation: result.explanation,
    };
  }

  // ✅ Modification réelle : on enregistre un nouvel état
  const { stepNumber } = await this.uploadService.addChatStep(
    database,
    sessionId,
    result.updatedSchema,
    message,
    result.explanation,
  );

  return { stepNumber, schema: result.updatedSchema, explanation: result.explanation };
}

@Post('schema/:database/session/:sessionId/revert/:stepNumber')
async revertToStep(
  @Param('database') database: string,
  @Param('sessionId') sessionId: number,
  @Param('stepNumber') stepNumber: number,
) {
  const schema = await this.uploadService.getSchemaAtStep(database, sessionId, stepNumber);
  if (!schema) throw new NotFoundException('Étape introuvable');

  // On rejoue cet état comme un nouveau step, pour garder l'historique linéaire (pas de perte de traçabilité)
  const { stepNumber: newStep } = await this.uploadService.addChatStep(
    database,
    sessionId,
    schema,
    `[Retour à l'étape ${stepNumber}]`,
    'Restauration demandée par l\'utilisateur',
  );

  return { stepNumber: newStep, schema };
}

@Get('schema/:database/session/:sessionId/history')
async getHistory(@Param('database') database: string, @Param('sessionId') sessionId: number) {
  return this.uploadService.getChatHistory(database, sessionId);
}
}