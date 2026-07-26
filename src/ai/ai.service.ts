import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { UploadService, ColumnMetadata, CrossTableRelation } from '../upload/upload.service';

export interface AiSchemaProposal {
  dimensions: string[];
  facts: string[];
  confirmedRelations: CrossTableRelation[];
  additionalRelations: CrossTableRelation[];
  rawResponse: string;
  warnings: string[];
}

@Injectable()
export class AiService {
  private readonly OLLAMA_URL = 'http://127.0.0.1:11434/api/generate';
  private readonly MODEL = 'qwen2.5:7b-instruct';
  private readonly MAX_RETRIES = 3;
  private readonly DERIVED_DIMENSION_PREFIXES = ['dimtemps', 'dimdate', 'dimtime', 'dimcalendar'];

  constructor(private uploadService: UploadService) {}

  async generateSchema(database: string): Promise<AiSchemaProposal> {
    const metadata = await this.uploadService.buildMetadataForDatabase(database);
    const preFilterRelations = this.uploadService.detectCrossTableRelations(metadata);

    const validTableNames = new Set(metadata.map((cols) => cols[0]?.sourceTable).filter(Boolean));
    const validColumnsByTable = new Map<string, Set<string>>();
    for (const cols of metadata) {
      if (cols.length === 0) continue;
      validColumnsByTable.set(cols[0].sourceTable, new Set(cols.map((c) => c.columnName)));
    }
    const hasDateColumn = metadata.some((table) => table.some((col) => col.dataType.toLowerCase().includes('date')));

    const prompt = this.buildPrompt(metadata, preFilterRelations, hasDateColumn);

    let lastError: string | null = null;
    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        const rawResponse = await this.callOllama(prompt);
        const parsed = this.parseAiResponse(rawResponse);
        const validated = this.validateAndClean(parsed, validTableNames, validColumnsByTable, metadata);
        return { ...validated, rawResponse };
      } catch (err) {
        lastError = err.message;
        console.warn(`Tentative ${attempt}/${this.MAX_RETRIES} échouée: ${lastError}`);
      }
    }

    throw new InternalServerErrorException(
      `L'IA n'a pas réussi à produire un schéma valide après ${this.MAX_RETRIES} tentatives. Dernière erreur: ${lastError}`,
    );
  }

  private buildPrompt(metadata: ColumnMetadata[][], relations: CrossTableRelation[], hasDateColumn: boolean): string {
    const dateRule = hasDateColumn
      ? `\n2b. Des colonnes de type date existent dans les données. Si pertinent, propose une dimension temporelle nommée exactement "DimTemps" dans "dimensions" — cette table est calculée automatiquement plus tard, elle n'a pas besoin d'exister dans les métadonnées fournies.`
      : '';

    return `Tu es un architecte BI expert en modélisation de data warehouse (schéma en étoile).

Métadonnées des tables de staging :
${JSON.stringify(metadata)}

Relations déjà détectées par un pré-filtre :
${JSON.stringify(relations)}

RÈGLES STRICTES à respecter absolument :
1. CHAQUE table de staging présente dans les métadonnées doit apparaître EXACTEMENT UNE FOIS, soit dans "dimensions", soit dans "facts". Ne jamais oublier une table, ne jamais en dupliquer une. Utilise EXCLUSIVEMENT les noms de tables tels qu'ils apparaissent dans les métadonnées (ex: "staging_Employees"), jamais un nom renommé.
2. N'invente JAMAIS de nom de table ou de colonne qui n'existe pas dans les métadonnées fournies, sauf la dimension temporelle décrite ci-dessous.${dateRule}
3. Chaque relation doit utiliser des noms de tables et colonnes EXACTEMENT identiques à ceux des métadonnées (respecte la casse), sauf pour "DimTemps" qui n'a pas de colonnes définies dans le staging.
4. "dimensions" et "facts" doivent être des tableaux de CHAÎNES DE CARACTÈRES SIMPLES (les noms de tables), jamais des objets avec des sous-propriétés.
5. Réponds STRICTEMENT en JSON valide, sans texte avant/après, selon ce format exact :

{"dimensions":["..."],"facts":["..."],"confirmedRelations":[{"tableA":"...","columnA":"...","tableB":"...","columnB":"...","reason":"..."}],"additionalRelations":[{"tableA":"...","columnA":"...","tableB":"...","columnB":"...","reason":"..."}]}`;
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
          options: { temperature: 0.1 },
        }),
        signal: AbortSignal.timeout(600000),
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

  private parseAiResponse(rawResponse: string): {
    dimensions: unknown[];
    facts: unknown[];
    confirmedRelations: any[];
    additionalRelations: any[];
  } {
    const cleaned = rawResponse.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      dimensions: parsed.dimensions ?? [],
      facts: parsed.facts ?? [],
      confirmedRelations: parsed.confirmedRelations ?? [],
      additionalRelations: parsed.additionalRelations ?? [],
    };
  }

  private isLegitimateDerivedDimension(tableName: unknown, hasDateColumn: boolean): boolean {
    if (typeof tableName !== 'string') return false;
    const normalized = tableName.toLowerCase().replace(/[_\s-]/g, '');
    const looksLikeTimeDimension = this.DERIVED_DIMENSION_PREFIXES.some((p) => normalized.includes(p));
    return looksLikeTimeDimension && hasDateColumn;
  }

  // Extrait un nom de table exploitable, que Qwen ait renvoyé une string ou un objet {tableName, columns}
  private normalizeTableEntry(entry: unknown, validTableNames: Set<string>): string | null {
    let candidateName: string;

    if (typeof entry === 'string') {
      candidateName = entry;
    } else if (entry && typeof entry === 'object' && 'tableName' in (entry as any)) {
      candidateName = String((entry as any).tableName);
    } else {
      return null;
    }

    if (validTableNames.has(candidateName)) return candidateName;

    const normalize = (s: string) => s.toLowerCase().replace(/^(staging_|dim|fact)/i, '').replace(/[_\s-]/g, '');
    const normalizedCandidate = normalize(candidateName);
    for (const realName of validTableNames) {
      if (normalize(realName) === normalizedCandidate) return realName;
    }

    return candidateName;
  }

  private detectLikelyFactTable(metadata: ColumnMetadata[][]): string | null {
    let bestCandidate: string | null = null;
    let bestScore = 0;

    for (const table of metadata) {
      if (table.length === 0) continue;
      const tableName = table[0].sourceTable;

      const foreignKeyCount = table.filter(
        (col) => col.columnName.toLowerCase().endsWith('key') && !col.isLikelyKey,
      ).length;
      const measureCount = table.filter(
        (col) =>
          this.isNumericType(col.dataType) && !col.isLikelyKey && !col.columnName.toLowerCase().endsWith('key'),
      ).length;

      const score = foreignKeyCount * 2 + measureCount;
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = tableName;
      }
    }

    return bestScore >= 3 ? bestCandidate : null;
  }

  private isNumericType(dataType: string): boolean {
    return ['int', 'decimal', 'numeric', 'float'].some((t) => dataType.toLowerCase().includes(t));
  }

  private validateAndClean(
    parsed: { dimensions: unknown[]; facts: unknown[]; confirmedRelations: any[]; additionalRelations: any[] },
    validTableNames: Set<string>,
    validColumnsByTable: Map<string, Set<string>>,
    metadata: ColumnMetadata[][],
  ): Omit<AiSchemaProposal, 'rawResponse'> {
    const warnings: string[] = [];
    const hasDateColumn = metadata.some((table) => table.some((col) => col.dataType.toLowerCase().includes('date')));

    const isKnownOrDerived = (t: string, bucket: string): boolean => {
      if (validTableNames.has(t)) return true;
      if (this.isLegitimateDerivedDimension(t, hasDateColumn)) {
        warnings.push(`Dimension dérivée acceptée (générée, absente du staging): ${t}`);
        return true;
      }
      warnings.push(`Table inventée ignorée (${bucket}): ${t}`);
      return false;
    };

    const normalizedDimensions = parsed.dimensions
      .map((t) => this.normalizeTableEntry(t, validTableNames))
      .filter((t): t is string => t !== null);
    const normalizedFacts = parsed.facts
      .map((t) => this.normalizeTableEntry(t, validTableNames))
      .filter((t): t is string => t !== null);

    const dimensions = normalizedDimensions.filter((t) => isKnownOrDerived(t, 'dimensions'));
    const facts = normalizedFacts.filter((t) => isKnownOrDerived(t, 'facts'));

    // Doublons entre dimensions et facts : priorité au fait
    const seen = new Set<string>();
    const cleanFacts = facts.filter((t) => {
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    });
    const cleanDimensions = dimensions.filter((t) => {
      if (seen.has(t)) {
        warnings.push(`Table ${t} classée à la fois en fact et dimension — gardée en fact uniquement`);
        return false;
      }
      seen.add(t);
      return true;
    });

    // Tables de staging jamais classées : ajoutées en dimension par défaut
    for (const tableName of validTableNames) {
      if (!seen.has(tableName)) {
        warnings.push(`Table ${tableName} non classée par l'IA — ajoutée en dimension par défaut`);
        cleanDimensions.push(tableName);
        seen.add(tableName);
      }
    }

    // Garde-fou 1 : au moins une table de faits
    if (cleanFacts.length === 0) {
      const fallbackFact = this.detectLikelyFactTable(metadata);
      if (fallbackFact && cleanDimensions.includes(fallbackFact)) {
        warnings.push(`Aucun fait identifié par l'IA — ${fallbackFact} reclassée en fait par heuristique de secours`);
        cleanDimensions.splice(cleanDimensions.indexOf(fallbackFact), 1);
        cleanFacts.push(fallbackFact);
      }
    }

    // Garde-fou 2 : DimTemps automatique si date dans le fait
    const factTableMeta = metadata.find((table) => cleanFacts.includes(table[0]?.sourceTable));
    const hasDateInFact = factTableMeta?.some((col) => col.dataType.toLowerCase().includes('date'));
    if (hasDateInFact && !cleanDimensions.some((d) => d.toLowerCase().includes('dimtemps'))) {
      warnings.push('DimTemps ajoutée automatiquement (colonne date détectée dans la table de faits)');
      cleanDimensions.push('DimTemps');
    }

    // Validation des relations : DimTemps acceptée sans vérification de colonnes
    const isValidRelation = (r: any): boolean => {
      if (!r || !r.tableA || !r.columnA || !r.tableB || !r.columnB) {
        warnings.push(`Relation incomplète ignorée: ${JSON.stringify(r)}`);
        return false;
      }

      const isDerivedA = this.isLegitimateDerivedDimension(r.tableA, hasDateColumn);
      const isDerivedB = this.isLegitimateDerivedDimension(r.tableB, hasDateColumn);

      if (!isDerivedA) {
        const colsA = validColumnsByTable.get(r.tableA);
        if (!colsA || !colsA.has(r.columnA)) {
          warnings.push(`Relation invalide ignorée (colonne inexistante ${r.tableA}.${r.columnA})`);
          return false;
        }
      }
      if (!isDerivedB) {
        const colsB = validColumnsByTable.get(r.tableB);
        if (!colsB || !colsB.has(r.columnB)) {
          warnings.push(`Relation invalide ignorée (colonne inexistante ${r.tableB}.${r.columnB})`);
          return false;
        }
      }
      return true;
    };

    const confirmedRelations = parsed.confirmedRelations.filter(isValidRelation);
    const additionalRelations = parsed.additionalRelations.filter(isValidRelation);

    return { dimensions: cleanDimensions, facts: cleanFacts, confirmedRelations, additionalRelations, warnings };
  }

  
}