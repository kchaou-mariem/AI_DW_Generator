import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { UploadService, ColumnMetadata, CrossTableRelation } from '../upload/upload.service';
// plus besoin d'importer 'undici'

export interface AiSchemaProposal {
  dimensions: string[];
  facts: string[];
  confirmedRelations: CrossTableRelation[];
  additionalRelations: {
    tableA: string;
    columnA: string;
    tableB: string;
    columnB: string;
    reason: string;
  }[];
  rawResponse: string;
}

@Injectable()
export class AiService {
  private readonly OLLAMA_URL = 'http://127.0.0.1:11434/api/generate';
  private readonly MODEL = 'qwen2.5:7b-instruct';

  constructor(private uploadService: UploadService) {}

  async generateSchema(database: string): Promise<AiSchemaProposal> {
    const metadata = await this.uploadService.buildMetadataForDatabase(database);
    const preFilterRelations = this.uploadService.detectCrossTableRelations(metadata);

    const prompt = this.buildPrompt(metadata, preFilterRelations);
    const rawResponse = await this.callOllama(prompt);
    const parsed = this.parseAiResponse(rawResponse);

    return { ...parsed, rawResponse };
  }
private buildPrompt(metadata: ColumnMetadata[][], relations: CrossTableRelation[]): string {
  return `Tu es un architecte BI expert en modélisation de data warehouse (schéma en étoile).

Métadonnées des tables de staging :
${JSON.stringify(metadata)}

Relations déjà détectées par un pré-filtre :
${JSON.stringify(relations)}

Ta tâche :
1. Identifie quelles tables devraient être des FAITS (mesures numériques agrégeables) et lesquelles des DIMENSIONS (attributs descriptifs).
2. Confirme ou complète les relations entre tables, y compris si les noms diffèrent mais désignent probablement la même entité.
3. Réponds STRICTEMENT en JSON valide, sans texte avant/après, format exact :

{"dimensions":["..."],"facts":["..."],"confirmedRelations":[{"tableA":"...","columnA":"...","tableB":"...","columnB":"...","reason":"..."}],"additionalRelations":[{"tableA":"...","columnA":"...","tableB":"...","columnB":"...","reason":"..."}]}

Ne mets aucun texte explicatif en dehors de ce JSON.`;
}

  private async callOllama(prompt: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(this.OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.MODEL,
          prompt,
          stream: false,
          format: 'json',
        }),
        signal: AbortSignal.timeout(600000), // 10 minutes, natif à fetch, pas de dépendance externe
      });
    } catch (err) {
      console.error('Erreur fetch Ollama:', err);
      throw new InternalServerErrorException(
        `Impossible de contacter Ollama sur ${this.OLLAMA_URL}. Vérifie qu'il est bien lancé.`,
      );
    }

    if (!response.ok) {
      throw new InternalServerErrorException(`Ollama a répondu avec une erreur: ${response.status}`);
    }

    const data = await response.json();
    return data.response;
  }

  private parseAiResponse(rawResponse: string): Omit<AiSchemaProposal, 'rawResponse'> {
    try {
      const cleaned = rawResponse.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      return {
        dimensions: parsed.dimensions ?? [],
        facts: parsed.facts ?? [],
        confirmedRelations: parsed.confirmedRelations ?? [],
        additionalRelations: parsed.additionalRelations ?? [],
      };
    } catch (err) {
      throw new InternalServerErrorException(
        `Réponse IA non parsable en JSON. Réponse brute reçue: ${rawResponse.slice(0, 200)}...`,
      );
    }
  }
}