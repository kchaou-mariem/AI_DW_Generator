import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { UploadService, ColumnMetadata, CrossTableRelation } from '../upload/upload.service';
import { Agent } from 'undici';

export interface AiSchemaProposal {
  dimensions: string[];
  facts: string[];
  confirmedRelations: CrossTableRelation[];
  additionalRelations: CrossTableRelation[];
  generatedDimensions: any[];
  factColumnTransformations: any[];
  subDimensions: SubDimension[];
  tableAttributes: Record<string, { name: string; type: string }[]>; // ← nouveau
  rawResponse: string;
  warnings: string[];
}
export interface SubDimension {
  name: string;
  parentDimension: string;
  sourceColumn: string;
  generatedPrimaryKey: string;
}

@Injectable()
export class AiService {
  private readonly OLLAMA_URL = 'http://127.0.0.1:11434/api/generate';
  private readonly MODEL = 'qwen2.5:3b-instruct';
  private readonly MAX_RETRIES = 3;
  private readonly DERIVED_DIMENSION_PREFIXES = ['dimtemps', 'dimdate', 'dimtime', 'dimcalendar'];

  constructor(private uploadService: UploadService) {}


  private toDisplayName(tableName: string): string {
  return tableName.replace(/^staging_/i, '');
}

// ✅ 1. D'abord les méthodes utilitaires (avant validateAndClean)
  private isLegitimateDerivedDimension(tableName: unknown, hasDateColumn: boolean): boolean {
    if (typeof tableName !== 'string') return false;
    const normalized = tableName.toLowerCase().replace(/[_\s-]/g, '');
    const looksLikeTimeDimension = this.DERIVED_DIMENSION_PREFIXES.some((p) => normalized.includes(p));
    return looksLikeTimeDimension && hasDateColumn;
  }

  private normalizeTableEntry(entry: unknown, validTableNames: Set<string>): string | null {
  let candidateName: string;

  if (typeof entry === 'string') {
    candidateName = entry;
  } else if (entry && typeof entry === 'object') {
    // ✅ Support du format {t: "tableName", c: [...]}
    if ('t' in (entry as any) && typeof (entry as any).t === 'string') {
      candidateName = String((entry as any).t);
    } 
    // ✅ Support du format {tableName: "tableName", columns: [...]}
    else if ('tableName' in (entry as any) && typeof (entry as any).tableName === 'string') {
      candidateName = String((entry as any).tableName);
    }
    // ✅ Support du format {name: "tableName", columns: [...]}
    else if ('name' in (entry as any) && typeof (entry as any).name === 'string') {
      candidateName = String((entry as any).name);
    }
    else {
      return null;
    }
  } else {
    return null;
  }

  // Nettoyer le nom (enlever les préfixes)
  const cleanName = candidateName.replace(/^staging_/i, '');
  
  // Vérifier si le nom exact existe
  if (validTableNames.has(candidateName)) return candidateName;
  if (validTableNames.has(cleanName)) return cleanName;
  
  // Vérifier avec le préfixe staging_
  const withPrefix = `staging_${cleanName}`;
  if (validTableNames.has(withPrefix)) return withPrefix;

  // Normalisation sans préfixe
  const normalize = (s: string) => s.toLowerCase().replace(/^(staging_|dim|fact)/i, '').replace(/[_\s-]/g, '');
  const normalizedCandidate = normalize(candidateName);
  for (const realName of validTableNames) {
    if (normalize(realName) === normalizedCandidate) return realName;
  }

  return candidateName;
}
private getSubDimensionCandidateSet(metadata: ColumnMetadata[][]): Set<string> {
  const candidates = new Set<string>();
  const excludedPatterns = ['firstname', 'lastname', 'fullname', 'name', 'title', 'email', 'phone', 'address', 'id', 'code'];

  for (const table of metadata) {
    // Récupérer le nombre total de lignes
    const totalRows = (table[0] as any)?.rowCount ?? 0;
    if (totalRows === 0) continue;

    for (const col of table) {
      const normalizedColName = col.columnName.toLowerCase().replace(/[_\s-]/g, '');
      const isExcluded = excludedPatterns.some((p) => normalizedColName.includes(p));

      // 🔥 Calcul du ratio cardinalité / total lignes
      const cardinalityRatio = col.cardinality / totalRows;

      if (
        col.dataType.toLowerCase().includes('varchar') &&
        !col.isLikelyKey &&
        !isExcluded &&
        col.cardinality > 1 &&
        col.cardinality <= 15 &&
        cardinalityRatio < 0.5  // Moins de 50% des lignes
      ) {
        candidates.add(`${col.sourceTable}.${col.columnName}`);
      }
    }
  }
  return candidates;
}

private applyDisplayNames(result: Omit<AiSchemaProposal, 'rawResponse'>): Omit<AiSchemaProposal, 'rawResponse'> {
  const rename = (t: string) => this.toDisplayName(t);

  const renamedAttributes: Record<string, { name: string; type: string }[]> = {};
  for (const [key, value] of Object.entries(result.tableAttributes ?? {})) {
    renamedAttributes[rename(key)] = value;
  }

  return {
    ...result,
    dimensions: result.dimensions.map(rename),
    facts: result.facts.map(rename),
    confirmedRelations: result.confirmedRelations.map((r) => ({
      ...r,
      tableA: rename(r.tableA),
      tableB: rename(r.tableB),
    })),
    additionalRelations: result.additionalRelations.map((r) => ({
      ...r,
      tableA: rename(r.tableA),
      tableB: rename(r.tableB),
    })),
    factColumnTransformations: result.factColumnTransformations.map((t: any) => ({
      ...t,
      factTable: rename(t.factTable),
    })),
    subDimensions: result.subDimensions.map((sd) => ({
      ...sd,
      parentDimension: rename(sd.parentDimension),
    })),
    tableAttributes: renamedAttributes,
  };
}

private buildTableAttributes(
  cleanDimensions: string[],
  cleanFacts: string[],
  metadata: ColumnMetadata[][],
  generatedDimensions: any[],
  subDimensions: SubDimension[],
): Record<string, { name: string; type: string }[]> {
  const attributes: Record<string, { name: string; type: string }[]> = {};

  const allRealTables = [...cleanDimensions, ...cleanFacts];
  for (const tableName of allRealTables) {
    const tableMeta = metadata.find((m) => m[0]?.sourceTable === tableName);
    if (tableMeta) {
      attributes[tableName] = tableMeta.map((col) => ({ name: col.columnName, type: col.dataType }));
    }
  }

  for (const gen of generatedDimensions) {
    attributes[gen.name] = gen.columns.map((c: any) => ({ name: c.name, type: c.type }));
  }

  for (const sd of subDimensions) {
    attributes[sd.name] = [
      { name: sd.generatedPrimaryKey, type: 'INT' },
      { name: sd.sourceColumn, type: 'VARCHAR' },
    ];
  }

  return attributes;
}

private toInternalName(displayName: string, validTableNames: Set<string>): string {
  if (validTableNames.has(displayName)) return displayName;
  const withPrefix = `staging_${displayName}`;
  if (validTableNames.has(withPrefix)) return withPrefix;
  if (displayName.toLowerCase().includes('dimtemps')) return displayName; // DimTemps n'a pas de préfixe
  return displayName; // sous-dimension ou cas non trouvé, laisse tel quel
}

private restoreInternalNames(schema: any, validTableNames: Set<string>): any {
  const restore = (t: string) => this.toInternalName(t, validTableNames);
  return {
    ...schema,
    dimensions: (schema.dimensions ?? []).map(restore),
    facts: (schema.facts ?? []).map(restore),
    confirmedRelations: (schema.confirmedRelations ?? []).map((r: any) => ({
      ...r,
      tableA: restore(r.tableA),
      tableB: restore(r.tableB),
    })),
  };
}

  async generateSchema(database: string): Promise<AiSchemaProposal> {
  const metadata = await this.getMetadataWithCache(database);
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
      const parsed = this.parseAiResponse(rawResponse) as any;

      // 🔥 RECONSTRUCTION DES RELATIONS DEPUIS LES INDEXES
      const selectedRelations = (parsed.validRelationIndexes as number[])
        .filter((i) => typeof i === 'number' && i >= 0 && i < preFilterRelations.length)
        .map((i) => ({
          ...preFilterRelations[i],
          // Nettoyer les noms (enlever staging_)
          tableA: preFilterRelations[i].tableA.replace(/^staging_/i, ''),
          tableB: preFilterRelations[i].tableB.replace(/^staging_/i, ''),
        }));

      // 🔥 Récupérer les sous-dimensions du modèle
      const subDimensions = parsed.subDimensions ?? [];

      // 🔥 Appeler validateAndClean avec les relations reconstruites
      const validated = this.validateAndClean(
        {
          dimensions: parsed.dimensions ?? [],
          facts: parsed.facts ?? [],
          confirmedRelations: selectedRelations,
          additionalRelations: [],
          subDimensions: subDimensions,
        },
        validTableNames,
        validColumnsByTable,
        metadata,
      );

      const displayed = this.applyDisplayNames(validated);
      return { ...displayed, rawResponse };

    } catch (err) {
      lastError = err.message;
      console.warn(`Tentative ${attempt}/${this.MAX_RETRIES} échouée: ${lastError}`);
    }
  }

  throw new InternalServerErrorException(
    `L'IA n'a pas réussi à produire un schéma valide après ${this.MAX_RETRIES} tentatives. Dernière erreur: ${lastError}`,
  );
}
  private findSubDimensionCandidates(metadata: ColumnMetadata[][]): string {
  const set = this.getSubDimensionCandidateSet(metadata);
  if (set.size === 0) return 'aucun candidat détecté';
  
  const labels: string[] = [];
  for (const table of metadata) {
    for (const col of table) {
      if (set.has(`${col.sourceTable}.${col.columnName}`)) {
        labels.push(`${col.sourceTable}.${col.columnName} (${col.cardinality} valeurs distinctes)`);
      }
    }
  }
  return labels.join(', ');
}

//   private buildPrompt(metadata: ColumnMetadata[][], relations: CrossTableRelation[], hasDateColumn: boolean): string {
//   const dateRule = hasDateColumn
//     ? `\n2b. Des colonnes de type date existent dans les données. Si pertinent, propose une dimension temporelle nommée exactement "DimTemps" dans "dimensions" — cette table est calculée automatiquement plus tard, elle n'a pas besoin d'exister dans les métadonnées fournies. Ne propose PAS de relation vers DimTemps toi-même, elle sera générée automatiquement.`
//     : '';

//   const subDimCandidates = this.findSubDimensionCandidates(metadata);
//   const hasSubDimCandidates = subDimCandidates !== 'aucun candidat détecté';

//   const subDimRule = hasSubDimCandidates
//     ? `\n6. Colonnes candidates pour une extraction en sous-dimension (faible cardinalité déjà détectée par calcul) : ${subDimCandidates}.
// Si l'une d'elles mérite vraiment d'être extraite (catégorie métier claire, forte répétition), propose-la au format :
// {"subDimensions": [{"name": "DimNomChoisi", "parentDimension": "nom_table_du_candidat", "sourceColumn": "nom_colonne_du_candidat", "generatedPrimaryKey": "NomCleGeneree"}]}
// N'invente RIEN en dehors de cette liste de candidats. IMPORTANT : ignore complètement "DimTemps" pour cette règle — la dimension temporelle est gérée séparément et automatiquement, ne la mentionne jamais dans "subDimensions".`
//     : `\n6. Aucune sous-dimension n'est à proposer ici. Laisse "subDimensions" à un tableau vide [].`;

//   return `Tu es un architecte BI expert en modélisation de data warehouse.

// Métadonnées des tables de staging :
// ${JSON.stringify(metadata)}

// Relations déjà détectées par un pré-filtre :
// ${JSON.stringify(relations)}

// RÈGLES STRICTES à respecter absolument :
// 1. CHAQUE table de staging présente dans les métadonnées doit apparaître EXACTEMENT UNE FOIS, soit dans "dimensions", soit dans "facts". Ne jamais oublier une table, ne jamais en dupliquer une. Utilise EXCLUSIVEMENT les noms de tables tels qu'ils apparaissent dans les métadonnées, jamais un nom renommé.
// 2. N'invente JAMAIS de nom de table ou de colonne qui n'existe pas dans les métadonnées fournies, sauf la dimension temporelle décrite ci-dessous.${dateRule}
// 3. Chaque relation doit utiliser des noms de tables et colonnes EXACTEMENT identiques à ceux des métadonnées (respecte la casse), sauf pour "DimTemps".
// 4. "dimensions" et "facts" doivent être des tableaux de CHAÎNES DE CARACTÈRES SIMPLES, jamais des objets.
// 5. INTERDIT : ne propose jamais de relation directe entre deux dimensions qui sont TOUTES LES DEUX déjà reliées directement à une table de faits.${subDimRule}
// 7. IMPORTANT — Constellation de faits : si tu identifies PLUSIEURS tables contenant chacune des mesures numériques agrégeables, tu DOIS les classer TOUTES dans "facts". Dans ce cas, assure-toi qu'au moins une dimension est reliée aux DEUX tables de faits.
// 8. Réponds STRICTEMENT en JSON valide, sans texte avant/après, selon ce format exact :

// {"dimensions":["..."],"facts":["..."],"confirmedRelations":[{"tableA":"...","columnA":"...","tableB":"...","columnB":"..."}],"additionalRelations":[{"tableA":"...","columnA":"...","tableB":"...","columnB":"..."}],"subDimensions":[]}`;
// }
private metadataCache = new Map<string, { data: ColumnMetadata[][]; timestamp: number }>();
private readonly CACHE_TTL = 60000; // 1 minute

async getMetadataWithCache(database: string): Promise<ColumnMetadata[][]> {
  const cached = this.metadataCache.get(database);
  if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
    console.log(`[Cache] Métadonnées utilisées depuis le cache pour ${database}`);
    return cached.data;
  }
  
  console.log(`[Cache] Chargement des métadonnées pour ${database}...`);
  const data = await this.uploadService.buildMetadataForDatabase(database);
  this.metadataCache.set(database, { data, timestamp: Date.now() });
  return data;
}

// private buildPrompt(metadata: ColumnMetadata[][], relations: CrossTableRelation[], hasDateColumn: boolean): string {
//   const dateRule = hasDateColumn
//     ? `\n2b. Des colonnes de type date existent dans les données. Si pertinent, propose une dimension temporelle nommée exactement "DimTemps" dans "dimensions" — cette table est calculée automatiquement plus tard, elle n'a pas besoin d'exister dans les métadonnées fournies. Ne propose PAS de relation vers DimTemps toi-même, elle sera générée automatiquement.`
//     : '';

//   const subDimCandidates = this.findSubDimensionCandidates(metadata);
//   const hasSubDimCandidates = subDimCandidates !== 'aucun candidat détecté';

//   const subDimRule = hasSubDimCandidates
//     ? `\n6. Colonnes candidates pour une extraction en sous-dimension (faible cardinalité déjà détectée par calcul) : ${subDimCandidates}.
// Si l'une d'elles mérite vraiment d'être extraite (catégorie métier claire, forte répétition), propose-la au format :
// {"subDimensions": [{"name": "DimNomChoisi", "parentDimension": "nom_table_du_candidat", "sourceColumn": "nom_colonne_du_candidat", "generatedPrimaryKey": "NomCleGeneree"}]}
// N'invente RIEN en dehors de cette liste de candidats. IMPORTANT : ignore complètement "DimTemps" pour cette règle — la dimension temporelle est gérée séparément et automatiquement, ne la mentionne jamais dans "subDimensions".`
//     : `\n6. Aucune sous-dimension n'est à proposer ici. Laisse "subDimensions" à un tableau vide [].`;

//   // 🔥 OPTIMISATION 1: Métadonnées COMPACTES (réduction de 80-90%)
//   const compactMetadata = metadata.map(table => ({
//     t: table[0]?.sourceTable,                    // t = table name
//     c: table.map(col => ({                       // c = columns
//       n: col.columnName,                         // n = name
//       d: col.dataType,                           // d = dataType
//       k: col.isLikelyKey,                        // k = isKey
//       f: col.columnName.toLowerCase().endsWith('key') || col.columnName.toLowerCase().includes('id') // f = foreign key suspect
//     }))
//   }));

//   // 🔥 OPTIMISATION 2: Relations COMPACTES (limité à 30 max)
//   const compactRelations = relations.slice(0, 30).map(r => ({
//     A: r.tableA,
//     a: r.columnA,
//     B: r.tableB,
//     b: r.columnB
//   }));

//   // ⚠️ MÊMES RÈGLES, NON MODIFIÉES
//   return `Tu es un architecte BI expert en modélisation de data warehouse.

// Métadonnées des tables de staging :
// ${JSON.stringify(compactMetadata)}

// Relations déjà détectées par un pré-filtre :
// ${JSON.stringify(compactRelations)}

// RÈGLES STRICTES à respecter absolument :
// 1. CHAQUE table de staging présente dans les métadonnées doit apparaître EXACTEMENT UNE FOIS, soit dans "dimensions", soit dans "facts". Ne jamais oublier une table, ne jamais en dupliquer une. Utilise EXCLUSIVEMENT les noms de tables tels qu'ils apparaissent dans les métadonnées, jamais un nom renommé.
// 2. N'invente JAMAIS de nom de table ou de colonne qui n'existe pas dans les métadonnées fournies, sauf la dimension temporelle décrite ci-dessous.${dateRule}
// 3. Chaque relation doit utiliser des noms de tables et colonnes EXACTEMENT identiques à ceux des métadonnées (respecte la casse), sauf pour "DimTemps".
// 4. "dimensions" et "facts" doivent être des tableaux de CHAÎNES DE CARACTÈRES SIMPLES, jamais des objets.
// 5. INTERDIT : ne propose jamais de relation directe entre deux dimensions qui sont TOUTES LES DEUX déjà reliées directement à une table de faits.${subDimRule}
// 7. IMPORTANT — Constellation de faits : si tu identifies PLUSIEURS tables contenant chacune des mesures numériques agrégeables, tu DOIS les classer TOUTES dans "facts". Dans ce cas, assure-toi qu'au moins une dimension est reliée aux DEUX tables de faits.
// 8. Réponds STRICTEMENT en JSON valide, sans texte avant/après, selon ce format exact :

// {"dimensions":["..."],"facts":["..."],"confirmedRelations":[{"tableA":"...","columnA":"...","tableB":"...","columnB":"..."}],"additionalRelations":[{"tableA":"...","columnA":"...","tableB":"...","columnB":"..."}],"subDimensions":[]}`;
// }


// private buildPrompt(metadata: ColumnMetadata[][], relations: CrossTableRelation[], hasDateColumn: boolean): string {
//   // 🔥 ULTRA-COMPACT
//   const compactMetadata = metadata.map(table => ({
//     t: table[0]?.sourceTable,
//     c: table
//       .filter(col => 
//         col.isLikelyKey || 
//         col.columnName.toLowerCase().includes('key') ||
//         col.columnName.toLowerCase().includes('id') ||
//         col.dataType.toLowerCase().includes('date') ||
//         col.dataType.toLowerCase().includes('varchar')
//       )
//       .map(col => col.columnName)
//       .join(', ')
//   }));

//   const compactRelations = relations.slice(0, 15).map(r => 
//     `${r.tableA}.${r.columnA}↔${r.tableB}.${r.columnB}`
//   );

//   const subDimCandidates = this.findSubDimensionCandidates(metadata);

//   return `BI expert. Tables:
// ${JSON.stringify(compactMetadata)}

// Relations (top 15):
// ${JSON.stringify(compactRelations)}

// RULES:
// 1. Each table in dimensions/facts once.
// 2. No invented names.${hasDateColumn ? ' Propose DimTemps.' : ''}
// 3. Use exact names.
// 4. ⚠️ dimensions = array of STRINGS only. Example: ["staging_Customers", "staging_Products"]
// 5. ⚠️ facts = array of STRINGS only. Example: ["staging_Sales", "staging_Returns"]
// 6. NO dim↔dim relations.
// 7. ⚠️ subDimensions format - ALL 3 fields REQUIRED:
//    {"subDimensions": [
//      {"name":"DimX","parentDimension":"staging_Table","sourceColumn":"column_name"}
//    ]}
//    ❌ DO NOT forget "sourceColumn" - it is MANDATORY!
//    ❌ DO NOT use objects without "sourceColumn"!
//    Good: {"name":"DimCity","parentDimension":"staging_Customers","sourceColumn":"City"}
//    Bad: {"name":"DimCity","parentDimension":"staging_Customers"}
// 8. CRITICAL: Multiple facts MUST share a common dimension.
// 9. ⚠️ confirmedRelations = array of OBJECTS with fields: tableA, columnA, tableB, columnB
//    Example: [{"tableA":"staging_Sales","columnA":"ProductKey","tableB":"staging_Products","columnB":"ProductKey"}]

// ⚠️ CRITICAL: Reply ONLY with valid JSON, no extra text.
// ⚠️ The response must start with { and end with }.

// JSON: {"dimensions":[],"facts":[],"confirmedRelations":[],"additionalRelations":[],"subDimensions":[]}`;
// }

private buildPrompt(metadata: ColumnMetadata[][], relations: CrossTableRelation[], hasDateColumn: boolean): string {
  const compactMetadata = metadata.map(table => ({
    t: table[0]?.sourceTable,
    c: table
      .filter(col => col.isLikelyKey || col.columnName.toLowerCase().includes('key') || col.columnName.toLowerCase().includes('id'))
      .map(col => col.columnName)
      .join(', ')
  }));

  const numberedRelations = relations.slice(0, 20).map((r, i) => 
    `${i}: ${r.tableA}.${r.columnA} ↔ ${r.tableB}.${r.columnB}`
  );

  const subDimCandidates = this.findSubDimensionCandidates(metadata);
  const dateHint = hasDateColumn
    ? ' If relevant, add "DimTemps" to "dimensions" (it is generated automatically, do not worry about its columns or relations).'
    : '';

  return `BI expert. Tables:
${JSON.stringify(compactMetadata)}

Relations pré-détectées (numérotées) :
${numberedRelations.join('\n')}

TASK:
1. Classify each table as dimension or fact. "dimensions" and "facts" MUST be arrays of plain STRINGS only, never objects.${dateHint}
2. From the numbered relations above, list the INDEX NUMBERS of relations that make sense in "validRelationIndexes": [0, 1, 2, ...]. Do NOT invent new relations, only pick from the numbered list.
3. Sub-dimensions from: ${subDimCandidates || 'none'}
   Only real business categories (not names/titles/ids). Format: {"name":"DimX","parentDimension":"table","sourceColumn":"col"}

⚠️ Reply ONLY with valid JSON:
{"dimensions":[],"facts":[],"validRelationIndexes":[],"subDimensions":[]}`;
}
//   private async callOllama(prompt: string): Promise<string> {
//   let response: Response;
//   const promptTokensApprox = Math.round(prompt.length / 4); // estimation grossière
//   console.log(`[Ollama] Envoi prompt (~${prompt.length} caractères, ~${promptTokensApprox} tokens estimés)`);

//   const startedAt = Date.now();

//   try {
//     response = await fetch(this.OLLAMA_URL, {
//   method: 'POST',
//   headers: { 'Content-Type': 'application/json' },
//   body: JSON.stringify({
//     model: this.MODEL,
//     prompt,
//     stream: false,
//     format: 'json',
//     options: { temperature: 0.1 },
//   }),
//   signal: AbortSignal.timeout(600000),
  
// } as any);
//   } catch (err) {
//     console.error('Erreur fetch Ollama:', err);
//     throw new InternalServerErrorException(
//       `Impossible de contacter Ollama sur ${this.OLLAMA_URL}. Vérifie qu'il est bien lancé.`,
//     );
//   }

//   if (!response.ok) {
//     throw new InternalServerErrorException(`Ollama a répondu avec une erreur: ${response.status}`);
//   }

//   const data = await response.json();
//   const totalMs = Date.now() - startedAt;

//   // Ollama renvoie des durées en nanosecondes quand stream: false
//   const toMs = (ns: number | undefined) => (ns ? (ns / 1_000_000).toFixed(0) : 'N/A');

//   console.log('[Ollama] --- Timing détaillé ---');
//   console.log(`[Ollama] Temps total mesuré (réseau inclus): ${totalMs} ms`);
//   console.log(`[Ollama] load_duration (chargement modèle en mémoire): ${toMs(data.load_duration)} ms`);
//   console.log(`[Ollama] prompt_eval_duration (lecture du prompt): ${toMs(data.prompt_eval_duration)} ms`);
//   console.log(`[Ollama] prompt_eval_count (tokens du prompt): ${data.prompt_eval_count ?? 'N/A'}`);
//   console.log(`[Ollama] eval_duration (génération de la réponse): ${toMs(data.eval_duration)} ms`);
//   console.log(`[Ollama] eval_count (tokens générés): ${data.eval_count ?? 'N/A'}`);
//   console.log('[Ollama] ------------------------');

//   return data.response;
// }

private async callOllama(prompt: string): Promise<string> {
  const startedAt = Date.now();
  const promptTokensApprox = Math.round(prompt.length / 4);
  console.log(`[Ollama] Envoi prompt (~${prompt.length} caractères, ~${promptTokensApprox} tokens estimés)`);

  try {
    const response = await fetch(this.OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.MODEL,
        prompt,
        stream: true,
        options: { 
          temperature: 0.1,
          num_predict: 4096, // Augmenté pour éviter les réponses tronquées
        },
      }),
      signal: AbortSignal.timeout(240000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new InternalServerErrorException(
        `Ollama a répondu avec une erreur: ${response.status} - ${errorText}`
      );
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new InternalServerErrorException('Impossible de lire le flux de réponse');
    }

    const decoder = new TextDecoder();
    let fullResponse = '';
    let chunkCount = 0;
    let lastLogTime = Date.now();

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.log(`[Ollama] Flux terminé. Total chunks: ${chunkCount}`);
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(line => line.trim());

      for (const line of lines) {
        // Ignorer les lignes qui ne commencent pas par { (pas du JSON valide)
        if (!line.trim().startsWith('{')) {
          continue;
        }

        try {
          const data = JSON.parse(line);
          
          if (data.response) {
            fullResponse += data.response;
            chunkCount++;

            const now = Date.now();
            if (now - lastLogTime > 5000) {
              console.log(`[Ollama] Progression: ${fullResponse.length} caractères reçus...`);
              lastLogTime = now;
            }
          }

          if (data.done === true) {
            console.log(`[Ollama] Génération terminée. Total caractères: ${fullResponse.length}`);
            console.log(`[Ollama] Statistiques:`, {
              total_duration: data.total_duration,
              load_duration: data.load_duration,
              prompt_eval_count: data.prompt_eval_count,
              prompt_eval_duration: data.prompt_eval_duration,
              eval_count: data.eval_count,
              eval_duration: data.eval_duration,
            });
          }
        } catch (e) {
          // Ignorer silencieusement les lignes mal formées (normal en streaming)
        }
      }
    }

    const totalMs = Date.now() - startedAt;
    const estimatedTokens = Math.round(fullResponse.length / 4);
    
    console.log(`[Ollama] --- RÉSUMÉ STREAMING ---`);
    console.log(`[Ollama] Temps total: ${totalMs} ms`);
    console.log(`[Ollama] Caractères reçus: ${fullResponse.length}`);
    console.log(`[Ollama] Tokens estimés: ${estimatedTokens}`);
    console.log(`[Ollama] Vitesse: ${Math.round(fullResponse.length / (totalMs / 1000))} caractères/seconde`);
    console.log(`[Ollama] -------------------------`);

    // Nettoyer la réponse des éventuels marqueurs Markdown
    const cleanedResponse = fullResponse
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();

    return cleanedResponse;

  } catch (err) {
    console.error('[Ollama] Erreur fetch:', err);
    
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new InternalServerErrorException(
        `Le modèle Ollama a mis trop de temps à répondre (2 minutes). Vérifie que le modèle "${this.MODEL}" est disponible.`
      );
    }
    
    throw new InternalServerErrorException(
      `Impossible de contacter Ollama sur ${this.OLLAMA_URL}. Vérifie qu'il est bien lancé. Erreur: ${err.message}`
    );
  }
}

  private parseAiResponse(rawResponse: string): {
  dimensions: unknown[];
  facts: unknown[];
  validRelationIndexes: unknown[];
  subDimensions: unknown[];
} {
  // 1. Nettoyage initial
  let cleaned = rawResponse
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim();

  // 2. Extraire le JSON
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    cleaned = jsonMatch[0];
  }

  // 3. Supprimer tout après le dernier }
  const lastBrace = cleaned.lastIndexOf('}');
  if (lastBrace > 0 && lastBrace < cleaned.length - 1) {
    cleaned = cleaned.substring(0, lastBrace + 1);
  }

  try {
    const parsed = JSON.parse(cleaned);
    return {
      dimensions: parsed.dimensions ?? [],
      facts: parsed.facts ?? [],
      validRelationIndexes: parsed.validRelationIndexes ?? [],
      subDimensions: parsed.subDimensions ?? [],
    };
  } catch (e) {
    console.error('[parseAiResponse] Erreur parsing:', e.message);
    console.error('[parseAiResponse] cleaned:', cleaned.substring(0, 500));
    
    // Fallback
    try {
      const repaired = cleaned.replace(/'/g, '"');
      const parsed = JSON.parse(repaired);
      return {
        dimensions: parsed.dimensions ?? [],
        facts: parsed.facts ?? [],
        validRelationIndexes: parsed.validRelationIndexes ?? [],
        subDimensions: parsed.subDimensions ?? [],
      };
    } catch (e2) {
      throw new InternalServerErrorException(
        `La réponse de l'IA n'est pas un JSON valide: ${e.message}`
      );
    }
  }
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

  private computeActualReason(tableA: string, columnA: string, tableB: string, columnB: string): string {
  const normalize = (s: string) => s.toLowerCase().replace(/[_\s-]/g, '');
  return normalize(columnA) === normalize(columnB)
    ? 'nom_de_colonne_similaire'
    : 'relation_proposee_par_ia_sans_similarite_de_nom';
}

  private buildDimTempsStructure(
  factTableName: string,
  dateColumnName: string,
): { generatedDimension: any; factTransformation: any; relation: any } {
  return {
    generatedDimension: {
      name: 'DimTemps',
      columns: [
        { name: 'DateKey', type: 'INT', isPrimaryKey: true },
        { name: 'Date', type: 'DATE', isPrimaryKey: false },
      ],
      sourceColumn: dateColumnName,
    },
    factTransformation: {
      factTable: factTableName,
      originalColumn: dateColumnName,
      newColumn: `${dateColumnName}Key`,
      newColumnType: 'INT',
      referencesTable: 'DimTemps',
      referencesColumn: 'DateKey',
    },
    relation: {
      tableA: factTableName,
      columnA: `${dateColumnName}Key`,
      tableB: 'DimTemps',
      columnB: 'DateKey',
      reason: 'dimension_temporelle_generee_automatiquement',
    },
  };
}
private validateSubDimensions(
  rawSubDimensions: unknown,
  validColumnsByTable: Map<string, Set<string>>,
  cleanDimensions: string[],
  warnings: string[],
  validTableNames: Set<string>,
  candidateSet: Set<string>, // ← NOUVEAU
): SubDimension[] {
  if (!Array.isArray(rawSubDimensions)) return [];
  const usedNames = new Set<string>();

  return rawSubDimensions
    .map((sdRaw: any) => {
      if (!sdRaw || !sdRaw.name || !sdRaw.parentDimension || !sdRaw.sourceColumn) {
        warnings.push(`Sous-dimension ignorée (champs manquants): ${JSON.stringify(sdRaw)}`);
        return null;
      }

      const normalizedParent = this.normalizeTableEntry(sdRaw.parentDimension, validTableNames) ?? sdRaw.parentDimension;
      const enforcedKeyName = `${sdRaw.sourceColumn}Key`;
      const sd = { ...sdRaw, parentDimension: normalizedParent, generatedPrimaryKey: enforcedKeyName };

      // ✅ NOUVEAU : rejet si hors liste de candidats calculée par le code
      if (!candidateSet.has(`${normalizedParent}.${sd.sourceColumn}`)) {
        warnings.push(
          `Sous-dimension ignorée (hors liste de candidats validés): ${sd.name} (${normalizedParent}.${sd.sourceColumn})`
        );
        return null;
      }

      if (String(sd.name).toLowerCase().includes('dimtemps') || String(sd.parentDimension).toLowerCase().includes('dimtemps')) {
        warnings.push(`Sous-dimension ignorée (confusion avec DimTemps): ${sd.name}`);
        return null;
      }
      if (!cleanDimensions.includes(sd.parentDimension)) {
        warnings.push(`Sous-dimension ignorée (parent "${sd.parentDimension}" invalide): ${sd.name}`);
        return null;
      }
      const parentCols = validColumnsByTable.get(sd.parentDimension);
      if (!parentCols || !parentCols.has(sd.sourceColumn)) {
        warnings.push(`Sous-dimension ignorée (colonne inexistante "${sd.sourceColumn}"): ${sd.name}`);
        return null;
      }
      if (cleanDimensions.includes(sd.name) || usedNames.has(sd.name)) {
        warnings.push(`Sous-dimension ignorée (conflit de nom): ${sd.name}`);
        return null;
      }

      usedNames.add(sd.name);
      return sd as SubDimension;
    })
    .filter((sd): sd is SubDimension => sd !== null);
}

//  private validateAndClean(
//     parsed: { dimensions: unknown[]; facts: unknown[]; confirmedRelations: any[]; additionalRelations: any[] },
//     validTableNames: Set<string>,
//     validColumnsByTable: Map<string, Set<string>>,
//     metadata: ColumnMetadata[][],
//   ): Omit<AiSchemaProposal, 'rawResponse'> {
//     const warnings: string[] = [];
//     const hasDateColumn = metadata.some((table) => table.some((col) => col.dataType.toLowerCase().includes('date')));

//     const isKnownOrDerived = (t: string, bucket: string): boolean => {
//       if (validTableNames.has(t)) return true;
//       if (this.isLegitimateDerivedDimension(t, hasDateColumn)) {
//         warnings.push(`Dimension dérivée acceptée (générée, absente du staging): ${t}`);
//         return true;
//       }
//       warnings.push(`Table inventée ignorée (${bucket}): ${t}`);
//       return false;
//     };

//     const normalizedDimensions = parsed.dimensions
//       .map((t) => this.normalizeTableEntry(t, validTableNames))
//       .filter((t): t is string => t !== null);
//     const normalizedFacts = parsed.facts
//       .map((t) => this.normalizeTableEntry(t, validTableNames))
//       .filter((t): t is string => t !== null);

//     const dimensions = normalizedDimensions.filter((t) => isKnownOrDerived(t, 'dimensions'));
//     const facts = normalizedFacts.filter((t) => isKnownOrDerived(t, 'facts'));

//     const seen = new Set<string>();
//     const cleanFacts = facts.filter((t) => {
//       if (seen.has(t)) return false;
//       seen.add(t);
//       return true;
//     });
//     const cleanDimensions = dimensions.filter((t) => {
//       if (seen.has(t)) {
//         warnings.push(`Table ${t} classée à la fois en fait et dimension — gardée en fait uniquement`);
//         return false;
//       }
//       seen.add(t);
//       return true;
//     });

//     for (const tableName of validTableNames) {
//       if (!seen.has(tableName)) {
//         warnings.push(`Table ${tableName} non classée par l'IA — ajoutée en dimension par défaut`);
//         cleanDimensions.push(tableName);
//         seen.add(tableName);
//       }
//     }

//     if (cleanFacts.length === 0) {
//       const fallbackFact = this.detectLikelyFactTable(metadata);
//       if (fallbackFact && cleanDimensions.includes(fallbackFact)) {
//         warnings.push(`Aucun fait identifié par l'IA — ${fallbackFact} reclassée en fait par heuristique de secours`);
//         cleanDimensions.splice(cleanDimensions.indexOf(fallbackFact), 1);
//         cleanFacts.push(fallbackFact);
//       }
//     }

   

//     // --- Validation structurelle des relations proposées par l'IA ---
//     // Note : toute relation impliquant DimTemps proposée par l'IA est ignorée ici,
//     // car DimTemps est gérée intégralement par code juste après (colonnes + relation générées automatiquement)
//     const structurallyValid = (r: any): boolean => {
//       if (!r || !r.tableA || !r.columnA || !r.tableB || !r.columnB) {
//         warnings.push(`Relation incomplète ignorée: ${JSON.stringify(r)}`);
//         return false;
//       }
//       if (r.tableA.toLowerCase().includes('dimtemps') || r.tableB.toLowerCase().includes('dimtemps')) {
//         warnings.push(`Relation vers DimTemps ignorée (générée automatiquement, pas par l'IA)`);
//         return false;
//       }
//       const colsA = validColumnsByTable.get(r.tableA);
//       if (!colsA || !colsA.has(r.columnA)) {
//         warnings.push(`Relation invalide ignorée (colonne inexistante ${r.tableA}.${r.columnA})`);
//         return false;
//       }
//       const colsB = validColumnsByTable.get(r.tableB);
//       if (!colsB || !colsB.has(r.columnB)) {
//         warnings.push(`Relation invalide ignorée (colonne inexistante ${r.tableB}.${r.columnB})`);
//         return false;
//       }
//       return true;
//     };

//     const allRelationsRaw = [...parsed.confirmedRelations, ...parsed.additionalRelations].filter(structurallyValid);

//     const dimensionsLinkedToFact = new Set<string>();
//     for (const r of allRelationsRaw) {
//       if (cleanFacts.includes(r.tableA) && cleanDimensions.includes(r.tableB)) dimensionsLinkedToFact.add(r.tableB);
//       if (cleanFacts.includes(r.tableB) && cleanDimensions.includes(r.tableA)) dimensionsLinkedToFact.add(r.tableA);
//     }

//     const isValidRelation = (r: any): boolean => {
//       const aIsFact = cleanFacts.includes(r.tableA);
//       const bIsFact = cleanFacts.includes(r.tableB);
//       if (aIsFact || bIsFact) return true;

//       const aLinked = dimensionsLinkedToFact.has(r.tableA);
//       const bLinked = dimensionsLinkedToFact.has(r.tableB);
//       if (aLinked && bLinked) {
//         warnings.push(
//           `Relation rejetée (${r.tableA} et ${r.tableB} sont toutes deux déjà reliées au fait — relation redondante/suspecte)`,
//         );
//         return false;
//       }
//       return true;
//     };

//     const confirmedRelations = parsed.confirmedRelations
//     .filter(structurallyValid)
//     .filter(isValidRelation)
//     .map((r: any) => ({ ...r, reason: this.computeActualReason(r.tableA, r.columnA, r.tableB, r.columnB) }));

//     const additionalRelations = parsed.additionalRelations
//     .filter(structurallyValid)
//     .filter(isValidRelation)
//     .map((r: any) => ({ ...r, reason: this.computeActualReason(r.tableA, r.columnA, r.tableB, r.columnB) }));

//      // --- Vérification de cohérence pour la constellation de faits ---
//     if (cleanFacts.length > 1) {
//       const dimensionsByFact = cleanFacts.map((fact) => {
//         const linked = new Set(
//           [...confirmedRelations, ...additionalRelations]
//             .filter((r) => r.tableA === fact || r.tableB === fact)
//             .map((r) => (r.tableA === fact ? r.tableB : r.tableA)),
//         );
//         return { fact, linked };
//       });

//       const allShared = dimensionsByFact.every((f, i) =>
//         dimensionsByFact.some((other, j) => i !== j && [...f.linked].some((d) => other.linked.has(d))),
//       );

//       if (!allShared) {
//         warnings.push('Constellation détectée mais aucune dimension partagée entre les faits — vérifier la cohérence');

//         // Suggestion automatique : cherche une colonne commune entre les tables de faits
//         const factMetas = cleanFacts.map((f) => metadata.find((m) => m[0]?.sourceTable === f));
//         for (let i = 0; i < factMetas.length; i++) {
//           for (let j = i + 1; j < factMetas.length; j++) {
//             const commonCols = factMetas[i]
//               ?.map((c) => c.columnName)
//               .filter((col) => factMetas[j]?.some((c2) => c2.columnName === col));
//             if (commonCols && commonCols.length > 0) {
//               warnings.push(
//                 `Suggestion : ${cleanFacts[i]} et ${cleanFacts[j]} partagent la colonne ${commonCols[0]} — envisager une dimension commune`,
//               );
//             }
//           }
//         }
//       }
//     }

//    // --- Génération automatique et complète de DimTemps (jamais laissée à l'IA) ---
//     // Cherche une colonne date pour CHAQUE fait, pas seulement le premier (cas constellation)
//     const factsWithDate = cleanFacts
//       .map((factName) => {
//         const factMeta = metadata.find((table) => table[0]?.sourceTable === factName);
//         const dateCol = factMeta?.find((col) => col.dataType.toLowerCase().includes('date'));
//         return dateCol ? { factName, dateCol } : null;
//       })
//       .filter((x): x is { factName: string; dateCol: ColumnMetadata } => x !== null);

//     let generatedDimensions: any[] = [];
//     let factColumnTransformations: any[] = [];
//     const finalConfirmedRelations = [...confirmedRelations];

//     if (factsWithDate.length > 0 && !cleanDimensions.some((d) => d.toLowerCase().includes('dimtemps'))) {
//       warnings.push('DimTemps ajoutée automatiquement (colonne date détectée dans au moins une table de faits)');
//       cleanDimensions.push('DimTemps');
//     }

//     const dimTempsPresent = cleanDimensions.some((d) => d.toLowerCase().includes('dimtemps'));
//     if (dimTempsPresent && factsWithDate.length > 0) {
//       // La structure de DimTemps (colonnes) n'est créée qu'une seule fois, partagée par tous les faits
//       const { generatedDimension } = this.buildDimTempsStructure(
//         factsWithDate[0].factName,
//         factsWithDate[0].dateCol.columnName,
//       );
//       generatedDimensions.push(generatedDimension);

//       // Une relation distincte est générée pour CHAQUE fait ayant sa propre colonne date
//       for (const { factName, dateCol } of factsWithDate) {
//         const { factTransformation, relation } = this.buildDimTempsStructure(factName, dateCol.columnName);
//         factColumnTransformations.push(factTransformation);
//         finalConfirmedRelations.push(relation);
//         warnings.push(
//           `Structure DimTemps liée à ${factName} : ${dateCol.columnName} → ${factTransformation.newColumn} (FK vers DimTemps.DateKey)`,
//         );
//       }
//     }

//    // --- Validation des sous-dimensions proposées par l'IA ---
//     const subDimensions = this.validateSubDimensions(
//   (parsed as any).subDimensions,
//   validColumnsByTable,
//   cleanDimensions,
//   warnings,
//   validTableNames,
// );

//    const tableAttributes = this.buildTableAttributes(
//   cleanDimensions,
//   cleanFacts,
//   metadata,
//   generatedDimensions,
//   subDimensions,
// );

// return {
//   dimensions: cleanDimensions,
//   facts: cleanFacts,
//   confirmedRelations: finalConfirmedRelations,
//   additionalRelations,
//   generatedDimensions,
//   factColumnTransformations,
//   subDimensions,
//   tableAttributes, // ← nouveau
//   warnings,
// };
  
//   }

// private validateAndClean(
//   parsed: { dimensions: unknown[]; facts: unknown[]; confirmedRelations: any[]; additionalRelations: any[] },
//   validTableNames: Set<string>,
//   validColumnsByTable: Map<string, Set<string>>,
//   metadata: ColumnMetadata[][],
// ): Omit<AiSchemaProposal, 'rawResponse'> {
//   const warnings: string[] = [];
//   const hasDateColumn = metadata.some((table) => table.some((col) => col.dataType.toLowerCase().includes('date')));

//   // ✅ CRÉER UNE VERSION NORMALISÉE DE validColumnsByTable (sans staging_)
//   const normalizedValidColumns = new Map<string, Set<string>>();
//   for (const [key, value] of validColumnsByTable.entries()) {
//     const normalizedKey = key.replace(/^staging_/i, '');
//     normalizedValidColumns.set(normalizedKey, value);
//     // Garder aussi la clé originale
//     normalizedValidColumns.set(key, value);
//   }

//   // --- 1. Normalisation des dimensions et faits ---
//   const isKnownOrDerived = (t: string, bucket: string): boolean => {
//     if (validTableNames.has(t)) return true;
//     if (this.isLegitimateDerivedDimension(t, hasDateColumn)) {
//       warnings.push(`Dimension dérivée acceptée (générée, absente du staging): ${t}`);
//       return true;
//     }
//     warnings.push(`Table inventée ignorée (${bucket}): ${t}`);
//     return false;
//   };

//   const normalizedDimensions = parsed.dimensions
//     .map((t) => this.normalizeTableEntry(t, validTableNames))
//     .filter((t): t is string => t !== null);
//   const normalizedFacts = parsed.facts
//     .map((t) => this.normalizeTableEntry(t, validTableNames))
//     .filter((t): t is string => t !== null);

//   const dimensions = normalizedDimensions.filter((t) => isKnownOrDerived(t, 'dimensions'));
//   const facts = normalizedFacts.filter((t) => isKnownOrDerived(t, 'facts'));

//   const seen = new Set<string>();
//   const cleanFacts = facts.filter((t) => {
//     if (seen.has(t)) return false;
//     seen.add(t);
//     return true;
//   });
//   const cleanDimensions = dimensions.filter((t) => {
//     if (seen.has(t)) {
//       warnings.push(`Table ${t} classée à la fois en fait et dimension — gardée en fait uniquement`);
//       return false;
//     }
//     seen.add(t);
//     return true;
//   });

//   // Ajouter les tables non classées
//   for (const tableName of validTableNames) {
//     if (!seen.has(tableName)) {
//       warnings.push(`Table ${tableName} non classée par l'IA — ajoutée en dimension par défaut`);
//       cleanDimensions.push(tableName);
//       seen.add(tableName);
//     }
//   }

//   // Fallback si aucun fait n'est identifié
//   if (cleanFacts.length === 0) {
//     const fallbackFact = this.detectLikelyFactTable(metadata);
//     if (fallbackFact && cleanDimensions.includes(fallbackFact)) {
//       warnings.push(`Aucun fait identifié par l'IA — ${fallbackFact} reclassée en fait par heuristique de secours`);
//       cleanDimensions.splice(cleanDimensions.indexOf(fallbackFact), 1);
//       cleanFacts.push(fallbackFact);
//     }
//   }

//   // --- 2. Validation structurelle des relations (avec normalizedValidColumns) ---
//   const structurallyValid = (r: any): boolean => {
//     if (!r || !r.tableA || !r.columnA || !r.tableB || !r.columnB) {
//       warnings.push(`Relation incomplète ignorée: ${JSON.stringify(r)}`);
//       return false;
//     }
//     // Nettoyer les noms (enlever staging_)
//     r.tableA = r.tableA.replace(/^staging_/i, '');
//     r.tableB = r.tableB.replace(/^staging_/i, '');
    
//     if (r.tableA.toLowerCase().includes('dimtemps') || r.tableB.toLowerCase().includes('dimtemps')) {
//       warnings.push(`Relation vers DimTemps ignorée (générée automatiquement, pas par l'IA)`);
//       return false;
//     }
    
//     // ✅ UTILISER normalizedValidColumns AU LIEU DE validColumnsByTable
//     const colsA = normalizedValidColumns.get(r.tableA);
//     if (!colsA || !colsA.has(r.columnA)) {
//       warnings.push(`Relation invalide ignorée (colonne inexistante ${r.tableA}.${r.columnA})`);
//       return false;
//     }
//     const colsB = normalizedValidColumns.get(r.tableB);
//     if (!colsB || !colsB.has(r.columnB)) {
//       warnings.push(`Relation invalide ignorée (colonne inexistante ${r.tableB}.${r.columnB})`);
//       return false;
//     }
//     return true;
//   };

//   // --- 3. Validation de la constellation ---
//   const allRelationsRaw = [...parsed.confirmedRelations, ...parsed.additionalRelations].filter(structurallyValid);

//   const dimensionsLinkedToFact = new Set<string>();
//   for (const r of allRelationsRaw) {
//     if (cleanFacts.includes(r.tableA) && cleanDimensions.includes(r.tableB)) dimensionsLinkedToFact.add(r.tableB);
//     if (cleanFacts.includes(r.tableB) && cleanDimensions.includes(r.tableA)) dimensionsLinkedToFact.add(r.tableA);
//   }

//   const isValidRelation = (r: any): boolean => {
//     const aIsFact = cleanFacts.includes(r.tableA);
//     const bIsFact = cleanFacts.includes(r.tableB);
//     if (aIsFact || bIsFact) return true;

//     const aLinked = dimensionsLinkedToFact.has(r.tableA);
//     const bLinked = dimensionsLinkedToFact.has(r.tableB);
//     if (aLinked && bLinked) {
//       warnings.push(
//         `Relation rejetée (${r.tableA} et ${r.tableB} sont toutes deux déjà reliées au fait — relation redondante/suspecte)`,
//       );
//       return false;
//     }
//     return true;
//   };

//   // --- 4. Construire les relations confirmées ---
//   let confirmedRelations = parsed.confirmedRelations
//     .filter(structurallyValid)
//     .filter(isValidRelation)
//     .map((r: any) => ({ 
//       ...r, 
//       reason: this.computeActualReason(r.tableA, r.columnA, r.tableB, r.columnB) 
//     }));

//   let additionalRelations = parsed.additionalRelations
//     .filter(structurallyValid)
//     .filter(isValidRelation)
//     .map((r: any) => ({ 
//       ...r, 
//       reason: this.computeActualReason(r.tableA, r.columnA, r.tableB, r.columnB) 
//     }));

//     const candidateSet = this.getSubDimensionCandidateSet(metadata);

//   // --- 5. Validation des sous-dimensions ---
//  const subDimensions = this.validateSubDimensions(
//   (parsed as any).subDimensions,
//   validColumnsByTable,
//   cleanDimensions,
//   warnings,
//   validTableNames,
//   candidateSet, // ← NOUVEAU
// );

//   // --- 6. Filtrer les relations vers les sous-dimensions ---
//   const subDimensionNames = new Set(subDimensions.map(sd => sd.name));

//   confirmedRelations = confirmedRelations.filter((r: any) => 
//     !subDimensionNames.has(r.tableA) && !subDimensionNames.has(r.tableB)
//   );

//   additionalRelations = additionalRelations.filter((r: any) => 
//     !subDimensionNames.has(r.tableA) && !subDimensionNames.has(r.tableB)
//   );

//   // --- 7. Vérification de cohérence pour la constellation de faits ---
//   if (cleanFacts.length > 1) {
//     const dimensionsByFact = cleanFacts.map((fact) => {
//       const linked = new Set(
//         [...confirmedRelations, ...additionalRelations]
//           .filter((r) => r.tableA === fact || r.tableB === fact)
//           .map((r) => (r.tableA === fact ? r.tableB : r.tableA)),
//       );
//       return { fact, linked };
//     });

//     const allShared = dimensionsByFact.every((f, i) =>
//       dimensionsByFact.some((other, j) => i !== j && [...f.linked].some((d) => other.linked.has(d))),
//     );

//     if (!allShared) {
//       warnings.push('Constellation détectée mais aucune dimension partagée entre les faits — vérifier la cohérence');

//       const factMetas = cleanFacts.map((f) => metadata.find((m) => m[0]?.sourceTable === f));
//       for (let i = 0; i < factMetas.length; i++) {
//         for (let j = i + 1; j < factMetas.length; j++) {
//           const commonCols = factMetas[i]
//             ?.map((c) => c.columnName)
//             .filter((col) => factMetas[j]?.some((c2) => c2.columnName === col));
//           if (commonCols && commonCols.length > 0) {
//             warnings.push(
//               `Suggestion : ${cleanFacts[i]} et ${cleanFacts[j]} partagent la colonne ${commonCols[0]} — envisager une dimension commune`,
//             );
//           }
//         }
//       }
//     }
//   }

//   // --- 8. Génération automatique de DimTemps ---
//   const factsWithDate = cleanFacts
//     .map((factName) => {
//       const factMeta = metadata.find((table) => table[0]?.sourceTable === factName);
//       const dateCol = factMeta?.find((col) => col.dataType.toLowerCase().includes('date'));
//       return dateCol ? { factName, dateCol } : null;
//     })
//     .filter((x): x is { factName: string; dateCol: ColumnMetadata } => x !== null);

//   let generatedDimensions: any[] = [];
//   let factColumnTransformations: any[] = [];
//   const finalConfirmedRelations = [...confirmedRelations];

//   if (factsWithDate.length > 0 && !cleanDimensions.some((d) => d.toLowerCase().includes('dimtemps'))) {
//     warnings.push('DimTemps ajoutée automatiquement (colonne date détectée dans au moins une table de faits)');
//     cleanDimensions.push('DimTemps');
//   }

//   const dimTempsPresent = cleanDimensions.some((d) => d.toLowerCase().includes('dimtemps'));
//   if (dimTempsPresent && factsWithDate.length > 0) {
//     const { generatedDimension } = this.buildDimTempsStructure(
//       factsWithDate[0].factName,
//       factsWithDate[0].dateCol.columnName,
//     );
//     generatedDimensions.push(generatedDimension);

//     for (const { factName, dateCol } of factsWithDate) {
//       const { factTransformation, relation } = this.buildDimTempsStructure(factName, dateCol.columnName);
//       factColumnTransformations.push(factTransformation);
//       finalConfirmedRelations.push(relation);
//       warnings.push(
//         `Structure DimTemps liée à ${factName} : ${dateCol.columnName} → ${factTransformation.newColumn} (FK vers DimTemps.DateKey)`,
//       );
//     }
//   }

//   // --- 9. Construction des attributs des tables ---
//   const tableAttributes = this.buildTableAttributes(
//     cleanDimensions,
//     cleanFacts,
//     metadata,
//     generatedDimensions,
//     subDimensions,
//   );

//   // --- 10. Retourner le résultat ---
//   return {
//     dimensions: cleanDimensions,
//     facts: cleanFacts,
//     confirmedRelations: finalConfirmedRelations,
//     additionalRelations,
//     generatedDimensions,
//     factColumnTransformations,
//     subDimensions,
//     tableAttributes,
//     warnings,
//   };
// }
private validateAndClean(
  parsed: { dimensions: unknown[]; facts: unknown[]; confirmedRelations: any[]; additionalRelations: any[];subDimensions?: unknown[]; },
  validTableNames: Set<string>,
  validColumnsByTable: Map<string, Set<string>>,
  metadata: ColumnMetadata[][],
  
): Omit<AiSchemaProposal, 'rawResponse'> {
  const warnings: string[] = [];
  const hasDateColumn = metadata.some((table) => table.some((col) => col.dataType.toLowerCase().includes('date')));

  // ✅ CRÉER UNE VERSION NORMALISÉE DE validColumnsByTable (sans staging_)
  const normalizedValidColumns = new Map<string, Set<string>>();
  for (const [key, value] of validColumnsByTable.entries()) {
    const normalizedKey = key.replace(/^staging_/i, '');
    normalizedValidColumns.set(normalizedKey, value);
    // Garder aussi la clé originale
    normalizedValidColumns.set(key, value);
  }

  // --- 1. Normalisation des dimensions et faits ---
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

  const seen = new Set<string>();
  const cleanFacts = facts.filter((t) => {
    if (seen.has(t)) return false;
    seen.add(t);
    return true;
  });
  const cleanDimensions = dimensions.filter((t) => {
    if (seen.has(t)) {
      warnings.push(`Table ${t} classée à la fois en fait et dimension — gardée en fait uniquement`);
      return false;
    }
    seen.add(t);
    return true;
  });

  // Ajouter les tables non classées
  for (const tableName of validTableNames) {
    if (!seen.has(tableName)) {
      warnings.push(`Table ${tableName} non classée par l'IA — ajoutée en dimension par défaut`);
      cleanDimensions.push(tableName);
      seen.add(tableName);
    }
  }

  // Fallback si aucun fait n'est identifié
  if (cleanFacts.length === 0) {
    const fallbackFact = this.detectLikelyFactTable(metadata);
    if (fallbackFact && cleanDimensions.includes(fallbackFact)) {
      warnings.push(`Aucun fait identifié par l'IA — ${fallbackFact} reclassée en fait par heuristique de secours`);
      cleanDimensions.splice(cleanDimensions.indexOf(fallbackFact), 1);
      cleanFacts.push(fallbackFact);
    }
  }

  // --- 2. Validation structurelle des relations (avec normalizedValidColumns) ---
  const structurallyValid = (r: any): boolean => {
    if (!r || !r.tableA || !r.columnA || !r.tableB || !r.columnB) {
      warnings.push(`Relation incomplète ignorée: ${JSON.stringify(r)}`);
      return false;
    }
    // Nettoyer les noms (enlever staging_)
    r.tableA = r.tableA.replace(/^staging_/i, '');
    r.tableB = r.tableB.replace(/^staging_/i, '');
    
    if (r.tableA.toLowerCase().includes('dimtemps') || r.tableB.toLowerCase().includes('dimtemps')) {
      warnings.push(`Relation vers DimTemps ignorée (générée automatiquement, pas par l'IA)`);
      return false;
    }
    
    // ✅ UTILISER normalizedValidColumns AU LIEU DE validColumnsByTable
    const colsA = normalizedValidColumns.get(r.tableA);
    if (!colsA || !colsA.has(r.columnA)) {
      warnings.push(`Relation invalide ignorée (colonne inexistante ${r.tableA}.${r.columnA})`);
      return false;
    }
    const colsB = normalizedValidColumns.get(r.tableB);
    if (!colsB || !colsB.has(r.columnB)) {
      warnings.push(`Relation invalide ignorée (colonne inexistante ${r.tableB}.${r.columnB})`);
      return false;
    }
    return true;
  };

  // --- 3. Validation de la constellation ---
  const allRelationsRaw = [...parsed.confirmedRelations, ...parsed.additionalRelations].filter(structurallyValid);

  const dimensionsLinkedToFact = new Set<string>();
  for (const r of allRelationsRaw) {
    if (cleanFacts.includes(r.tableA) && cleanDimensions.includes(r.tableB)) dimensionsLinkedToFact.add(r.tableB);
    if (cleanFacts.includes(r.tableB) && cleanDimensions.includes(r.tableA)) dimensionsLinkedToFact.add(r.tableA);
  }

  const isValidRelation = (r: any): boolean => {
    const aIsFact = cleanFacts.includes(r.tableA);
    const bIsFact = cleanFacts.includes(r.tableB);
    if (aIsFact || bIsFact) return true;

    const aLinked = dimensionsLinkedToFact.has(r.tableA);
    const bLinked = dimensionsLinkedToFact.has(r.tableB);
    if (aLinked && bLinked) {
      warnings.push(
        `Relation rejetée (${r.tableA} et ${r.tableB} sont toutes deux déjà reliées au fait — relation redondante/suspecte)`,
      );
      return false;
    }
    return true;
  };

  // --- 4. Construire les relations confirmées ---
 // Dans validateAndClean, la partie 4 devient :
// --- 4. Construire les relations confirmées ---
// Les relations sont déjà reconstruites depuis les indexes, on les garde telles quelles
let confirmedRelations = parsed.confirmedRelations
  .filter((r: any) => r && r.tableA && r.columnA && r.tableB && r.columnB)
  .map((r: any) => ({
    ...r,
    reason: r.reason || 'relation_confirmee_par_ia'
  }));

let additionalRelations = parsed.additionalRelations
  .filter((r: any) => r && r.tableA && r.columnA && r.tableB && r.columnB)
  .map((r: any) => ({
    ...r,
    reason: r.reason || 'relation_additionnelle'
  }));
  // --- 5. Validation des sous-dimensions ---
  // Calculer la liste des candidats valides
  const candidateSet = this.getSubDimensionCandidateSet(metadata);
  
  const subDimensions = this.validateSubDimensions(
    (parsed as any).subDimensions,
    validColumnsByTable,
    cleanDimensions,
    warnings,
    validTableNames,
    candidateSet,
  );

  // --- 6. Filtrer les relations vers les sous-dimensions ---
  const subDimensionNames = new Set(subDimensions.map(sd => sd.name));

  confirmedRelations = confirmedRelations.filter((r: any) => 
    !subDimensionNames.has(r.tableA) && !subDimensionNames.has(r.tableB)
  );

  additionalRelations = additionalRelations.filter((r: any) => 
    !subDimensionNames.has(r.tableA) && !subDimensionNames.has(r.tableB)
  );

  // --- 7. Vérification de cohérence pour la constellation de faits ---
  if (cleanFacts.length > 1) {
    const dimensionsByFact = cleanFacts.map((fact) => {
      const linked = new Set(
        [...confirmedRelations, ...additionalRelations]
          .filter((r) => r.tableA === fact || r.tableB === fact)
          .map((r) => (r.tableA === fact ? r.tableB : r.tableA)),
      );
      return { fact, linked };
    });

    const allShared = dimensionsByFact.every((f, i) =>
      dimensionsByFact.some((other, j) => i !== j && [...f.linked].some((d) => other.linked.has(d))),
    );

    if (!allShared) {
      warnings.push('Constellation détectée mais aucune dimension partagée entre les faits — vérifier la cohérence');

      const factMetas = cleanFacts.map((f) => metadata.find((m) => m[0]?.sourceTable === f));
      for (let i = 0; i < factMetas.length; i++) {
        for (let j = i + 1; j < factMetas.length; j++) {
          const commonCols = factMetas[i]
            ?.map((c) => c.columnName)
            .filter((col) => factMetas[j]?.some((c2) => c2.columnName === col));
          if (commonCols && commonCols.length > 0) {
            warnings.push(
              `Suggestion : ${cleanFacts[i]} et ${cleanFacts[j]} partagent la colonne ${commonCols[0]} — envisager une dimension commune`,
            );
          }
        }
      }
    }
  }

  // --- 8. Génération automatique de DimTemps ---
  const factsWithDate = cleanFacts
    .map((factName) => {
      const factMeta = metadata.find((table) => table[0]?.sourceTable === factName);
      const dateCol = factMeta?.find((col) => col.dataType.toLowerCase().includes('date'));
      return dateCol ? { factName, dateCol } : null;
    })
    .filter((x): x is { factName: string; dateCol: ColumnMetadata } => x !== null);

  let generatedDimensions: any[] = [];
  let factColumnTransformations: any[] = [];
  const finalConfirmedRelations = [...confirmedRelations];

  if (factsWithDate.length > 0 && !cleanDimensions.some((d) => d.toLowerCase().includes('dimtemps'))) {
    warnings.push('DimTemps ajoutée automatiquement (colonne date détectée dans au moins une table de faits)');
    cleanDimensions.push('DimTemps');
  }

  const dimTempsPresent = cleanDimensions.some((d) => d.toLowerCase().includes('dimtemps'));
  if (dimTempsPresent && factsWithDate.length > 0) {
    const { generatedDimension } = this.buildDimTempsStructure(
      factsWithDate[0].factName,
      factsWithDate[0].dateCol.columnName,
    );
    generatedDimensions.push(generatedDimension);

    for (const { factName, dateCol } of factsWithDate) {
      const { factTransformation, relation } = this.buildDimTempsStructure(factName, dateCol.columnName);
      factColumnTransformations.push(factTransformation);
      finalConfirmedRelations.push(relation);
      warnings.push(
        `Structure DimTemps liée à ${factName} : ${dateCol.columnName} → ${factTransformation.newColumn} (FK vers DimTemps.DateKey)`,
      );
    }
  }

  // --- 9. 🔥 FALLBACK : Si aucune relation n'a été proposée par l'IA ---
  if (finalConfirmedRelations.length === 0 && additionalRelations.length === 0) {
    warnings.push('Aucune relation proposée par l\'IA - utilisation des relations pré-détectées par heuristique');
    
    // Utiliser les relations pré-détectées par l'heuristique
    const preFilterRelations = this.uploadService.detectCrossTableRelations(metadata);
    let fallbackCount = 0;
    
    for (const rel of preFilterRelations) {
      // Nettoyer les noms (enlever staging_)
      const tableA = rel.tableA.replace(/^staging_/i, '');
      const tableB = rel.tableB.replace(/^staging_/i, '');
      
      // Vérifier que les tables existent dans les dimensions ou faits
      const aExists = cleanDimensions.includes(tableA) || cleanFacts.includes(tableA);
      const bExists = cleanDimensions.includes(tableB) || cleanFacts.includes(tableB);
      
      if (aExists && bExists) {
        // Vérifier que les colonnes existent
        const colsA = normalizedValidColumns.get(tableA);
        const colsB = normalizedValidColumns.get(tableB);
        
        if (colsA?.has(rel.columnA) && colsB?.has(rel.columnB)) {
          // Éviter les doublons
          const isDuplicate = finalConfirmedRelations.some((r: any) => 
            r.tableA === tableA && r.columnA === rel.columnA && 
            r.tableB === tableB && r.columnB === rel.columnB
          );
          
          if (!isDuplicate) {
            finalConfirmedRelations.push({
              tableA,
              columnA: rel.columnA,
              tableB,
              columnB: rel.columnB,
              reason: 'relation_pre_detectee_par_heuristique'
            });
            fallbackCount++;
          }
        }
      }
    }
    
    if (fallbackCount > 0) {
      warnings.push(`${fallbackCount} relations récupérées via le fallback heuristique`);
    } else {
      warnings.push('Aucune relation n\'a pu être récupérée via le fallback');
    }
  }

  // --- 10. Construction des attributs des tables ---
  const tableAttributes = this.buildTableAttributes(
    cleanDimensions,
    cleanFacts,
    metadata,
    generatedDimensions,
    subDimensions,
  );

  // --- 11. Retourner le résultat ---
  return {
    dimensions: cleanDimensions,
    facts: cleanFacts,
    confirmedRelations: finalConfirmedRelations,
    additionalRelations,
    generatedDimensions,
    factColumnTransformations,
    subDimensions,
    tableAttributes,
    warnings,
  };
}

private buildChatPrompt(currentSchema: any, userMessage: string): string {
  return `Tu es un assistant qui aide à valider un schéma de data warehouse en dialoguant avec l'utilisateur.

Schéma actuel :
${JSON.stringify({ dimensions: currentSchema.dimensions, facts: currentSchema.facts, confirmedRelations: currentSchema.confirmedRelations, subDimensions: currentSchema.subDimensions, tableAttributes: currentSchema.tableAttributes })}

Message de l'utilisateur : "${userMessage}"

Réponds à sa question ou sa demande de façon naturelle et utile, en français. Si sa demande implique une modification claire du schéma (déplacer une table, ajouter/retirer une relation), applique-la, en respectant ces règles :
- INTERDIT : ne propose jamais de relation directe entre deux dimensions qui sont TOUTES LES DEUX déjà reliées directement à une table de faits.
- Le schéma peut avoir PLUSIEURS tables de faits (constellation) si l'utilisateur le demande — dans ce cas, veille à ce qu'au moins une dimension reste reliée aux différentes tables de faits.
- N'invente jamais de nom de table ou de colonne qui n'existe pas déjà dans le schéma actuel ou les métadonnées d'origine.
- Ne modifie jamais "DimTemps" ni ses relations — cette dimension est gérée automatiquement, ignore toute demande à son sujet et explique-le à l'utilisateur si besoin.

Sinon, réponds simplement sans modifier le schéma.

Réponds STRICTEMENT en JSON avec ce format :
{"reply":"ta réponse conversationnelle à l'utilisateur","dimensions":["..."],"facts":["..."],"confirmedRelations":[...]}

Les champs "dimensions", "facts", "confirmedRelations" doivent TOUJOURS être présents et refléter le schéma actuel — inchangé si aucune modification n'était demandée, modifié sinon.`;
}

  private computeDiffExplanation(oldSchema: any, newSchema: any): string {
    const changes: string[] = [];

    const oldDimensions = oldSchema.dimensions ?? [];
    const oldFacts = oldSchema.facts ?? [];
    const newDimensions = newSchema.dimensions ?? [];
    const newFacts = newSchema.facts ?? [];

    const movedToFacts = newFacts.filter((t: string) => oldDimensions.includes(t));
    const movedToDimensions = newDimensions.filter((t: string) => oldFacts.includes(t));

    movedToFacts.forEach((t: string) => changes.push(`${t} déplacée de dimension vers fait`));
    movedToDimensions.forEach((t: string) => changes.push(`${t} déplacée de fait vers dimension`));

    const addedDimensions = newDimensions.filter(
      (t: string) => !oldDimensions.includes(t) && !oldFacts.includes(t),
    );
    const addedFacts = newFacts.filter((t: string) => !oldDimensions.includes(t) && !oldFacts.includes(t));
    addedDimensions.forEach((t: string) => changes.push(`${t} ajoutée en dimension`));
    addedFacts.forEach((t: string) => changes.push(`${t} ajoutée en fait`));

    const oldRelations = oldSchema.confirmedRelations ?? [];
    const newRelations = newSchema.confirmedRelations ?? [];

    const relationKey = (r: any) => `${r.tableA}.${r.columnA}-${r.tableB}.${r.columnB}`;
    const oldKeys = new Set(oldRelations.map(relationKey));
    const newKeys = new Set(newRelations.map(relationKey));

    const added = newRelations.filter((r: any) => !oldKeys.has(relationKey(r)));
    const removed = oldRelations.filter((r: any) => !newKeys.has(relationKey(r)));

    if (added.length > 0) changes.push(`${added.length} relation(s) ajoutée(s)`);
    if (removed.length > 0) changes.push(`${removed.length} relation(s) supprimée(s)`);

    return changes.length > 0 ? changes.join(' ; ') : 'Aucun changement détecté dans le schéma';
  }


async applyChatModification(
  database: string,
  currentSchema: any,
  userMessage: string,
): Promise<{ updatedSchema: AiSchemaProposal; explanation: string }> {
  const metadata = await this.uploadService.buildMetadataForDatabase(database);
  const validTableNames = new Set(metadata.map((cols) => cols[0]?.sourceTable).filter(Boolean));
  const validColumnsByTable = new Map<string, Set<string>>();
  for (const cols of metadata) {
    if (cols.length === 0) continue;
    validColumnsByTable.set(cols[0].sourceTable, new Set(cols.map((c) => c.columnName)));
  }

  // Remet les noms internes AVANT tout traitement, pour rester cohérent avec validColumnsByTable
  const internalCurrentSchema = this.restoreInternalNames(currentSchema, validTableNames);

  const prompt = this.buildChatPrompt(internalCurrentSchema, userMessage);

  let lastError: string | null = null;
  for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
    try {
      const rawResponse = await this.callOllama(prompt);
      const cleaned = rawResponse.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);

      const validated = this.validateAndClean(
        {
          dimensions: parsed.dimensions ?? internalCurrentSchema.dimensions,
          facts: parsed.facts ?? internalCurrentSchema.facts,
          confirmedRelations: parsed.confirmedRelations ?? internalCurrentSchema.confirmedRelations,
          additionalRelations: [],
          subDimensions: parsed.subDimensions ?? [],
        } as any,
        validTableNames,
        validColumnsByTable,
        metadata,
      );

      const diffText = this.computeDiffExplanation(internalCurrentSchema, validated);
      const hasRealChange = diffText !== 'Aucun changement détecté dans le schéma';

      const finalReply = hasRealChange
        ? `${parsed.reply ?? ''}\n\n(Changement appliqué : ${diffText})`
        : parsed.reply ?? "Je n'ai pas de réponse claire à ta demande, peux-tu reformuler ?";

      const displayed = this.applyDisplayNames(validated);

      return {
        updatedSchema: { ...displayed, rawResponse },
        explanation: finalReply,
      };
    } catch (err) {
      lastError = err.message;
      console.warn(`Chat - tentative ${attempt}/${this.MAX_RETRIES} échouée: ${lastError}`);
    }
  }

  throw new InternalServerErrorException(
    `L'IA n'a pas réussi à traiter ta demande après ${this.MAX_RETRIES} tentatives. Dernière erreur: ${lastError}`,
  );
}

}