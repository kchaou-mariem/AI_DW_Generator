import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { UploadService, ColumnMetadata, CrossTableRelation } from '../upload/upload.service';
import { Agent } from 'undici';

export interface AiSchemaProposal {
  dimensions: string[];
  facts: string[];
  confirmedRelations: any[];
  additionalRelations: any[];
  generatedDimensions: any[];
  factColumnTransformations: any[];
  subDimensions: SubDimension[];
  tableAttributes: Record<string, { name: string; type: string }[]>;
  virtualFacts: VirtualFact[];
  virtualDimensions: VirtualDimension[];
  excludedColumns: Record<string, string[]>;
  columnTransformations: ColumnTransformation[];
  tableRenames: TableRename[];
  addedColumns: Record<string, { name: string; type: string }[]>; // ✅ NOUVEAU — colonnes ajoutées à des tables réelles
  warnings: string[];
  rawResponse?: string;
}
export interface ColumnTransformation {
  table: string;
  originalColumn: string;
  newColumn: string;
  newColumnType: string;
}
export interface SubDimension {
  name: string;
  parentDimension: string;
  sourceColumn: string;
  generatedPrimaryKey: string;
}
export interface TableRename {
  stagingTable: string; // nom réel dans le staging, ex. "staging_Employees"
  displayName: string;  // nom affiché après renommage, ex. "emp"
}
export interface VirtualFact {
  name: string;
  dimensionNames: string[];
  measures?: { name: string; type: string }[];
}

export interface VirtualDimension {
  name: string;
  linkedFact: string;
  extraColumns?: { name: string; type: string }[];
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

private stripPrefix(t: unknown): string {
  if (typeof t !== 'string') return '';
  return t.replace(/^staging_/i, '');
}
/**
 * Cherche, parmi toutes les tables connues du schéma (dimensions et faits, réels et virtuels),
 * celle dont le nom apparaît réellement dans le message utilisateur. Utilisé pour corriger
 * une hallucination du LLM sur le champ "table"/"dimension"/"fact" plutôt que de rejeter
 * systématiquement (le LLM 3B a tendance à recopier une table citée dans l'historique récent
 * au lieu de lire le nouveau message).
 */
private resolveTableFromMessage(userMessage: string, schema: any): string | null {
  const normalize = (s: string) =>
    s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[_\s-]/g, '');
  const normalizedMessage = normalize(userMessage);

  const candidates: string[] = [
    ...(schema.dimensions ?? []).map((d: string) => this.stripPrefix(d)),
    ...(schema.facts ?? []).map((f: string) => this.stripPrefix(f)),
  ];

  // Dédoublonne et trie du plus long au plus court, pour qu'un nom plus spécifique
  // (ex: "SalesTerritory") ne soit pas court-circuité par un nom plus court inclus dedans (ex: "Sales").
  const uniqueCandidates = [...new Set(candidates)].sort((a, b) => b.length - a.length);

  const matches = uniqueCandidates.filter((c) => normalizedMessage.includes(normalize(c)));
  if (matches.length === 0) return null;
  return matches[0];
}
/**
 * Cherche, parmi les colonnes valides d'une table cible donnée (déjà résolue), celle qui
 * apparaît réellement dans le message utilisateur. Même logique que resolveTableFromMessage,
 * mais appliquée aux colonnes — corrige l'hallucination du LLM qui recopie un nom de colonne
 * cité dans un tour précédent (ex: "colA" ajoutée à Resellers) au lieu de lire le nouveau
 * message ("productName" de Products).
 */
private resolveColumnFromMessage(userMessage: string, candidates: string[]): string | null {
  const normalize = (s: string) =>
    s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[_\s-]/g, '');
  const normalizedMessage = normalize(userMessage);

  const uniqueCandidates = [...new Set(candidates)].sort((a, b) => b.length - a.length);
  const matches = uniqueCandidates.filter((c) => normalizedMessage.includes(normalize(c)));
  if (matches.length === 0) return null;
  return matches[0];
}

/**
 * Retourne la liste des noms de colonnes valides pour la table cible d'une action donnée,
 * selon son type (dimension virtuelle, fait virtuel, ou table réelle du staging). Utilisé
 * uniquement pour l'auto-correction du nom de colonne — ne remplace pas la validation stricte
 * qui a lieu ensuite dans applyChatAction (colonne "introuvable" reste un filet de sécurité).
 */
private getColumnCandidatesForAction(actionType: string, tableFieldValue: string, schema: any): string[] {
  const stripped = this.stripPrefix(tableFieldValue);

  if (actionType === 'rename_column' || actionType === 'change_column_type') {
    const vd = (schema.virtualDimensions ?? []).find((v: any) => v.name.toLowerCase() === stripped.toLowerCase());
    return vd ? (vd.extraColumns ?? []).map((c: any) => c.name) : [];
  }

  if (actionType === 'rename_fact_measure') {
    const vf = (schema.virtualFacts ?? []).find((v: any) => v.name.toLowerCase() === stripped.toLowerCase());
    return vf ? (vf.measures ?? []).map((m: any) => m.name) : [];
  }

  if (actionType === 'rename_real_column') {
    const key = Object.keys(schema.tableAttributes ?? {}).find(
      (k) => this.stripPrefix(k).toLowerCase() === stripped.toLowerCase(),
    );
    return key ? (schema.tableAttributes[key] ?? []).map((a: any) => a.name) : [];
  }

  if (actionType === 'remove_dimension_column') {
    const vd = (schema.virtualDimensions ?? []).find((v: any) => v.name.toLowerCase() === stripped.toLowerCase());
    if (vd) return (vd.extraColumns ?? []).map((c: any) => c.name);
    const key = Object.keys(schema.tableAttributes ?? {}).find(
      (k) => this.stripPrefix(k).toLowerCase() === stripped.toLowerCase(),
    );
    return key ? (schema.tableAttributes[key] ?? []).map((a: any) => a.name) : [];
  }

  return [];
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
  const MIN_ROWS_TO_CONSIDER = 5;

  console.log('[DEBUG] === getSubDimensionCandidateSet ===');
  
  for (const table of metadata) {
    if (table.length === 0) continue;
    
    const sourceTable = table[0].sourceTable;
    const rowCount = table[0].rowCount;
    console.log(`[DEBUG] Table: ${sourceTable}, rowCount: ${rowCount}, type: ${typeof rowCount}`);
    
    if (rowCount === undefined || rowCount === null) {
      console.log(`[DEBUG] ⚠️ rowCount est undefined/null pour ${sourceTable} !`);
      continue;
    }
    
    if (rowCount === 0 || rowCount < MIN_ROWS_TO_CONSIDER) {
      console.log(`[DEBUG] Table ${sourceTable} exclue (${rowCount} lignes < ${MIN_ROWS_TO_CONSIDER})`);
      continue;
    }

    // 🔥 Seuil adaptatif selon la taille de la table
    let maxRatio;
    if (rowCount <= 20) {
      maxRatio = 0.7;  // Petite table : plus tolérant
    } else if (rowCount <= 50) {
      maxRatio = 0.5;  // Table moyenne
    } else {
      maxRatio = 0.3;  // Grande table : plus strict
    }

    for (const col of table) {
      const normalizedColName = col.columnName.toLowerCase().replace(/[_\s-]/g, '');
      const isExcluded = excludedPatterns.some((p) => normalizedColName.includes(p));
      const cardinalityRatio = col.cardinality / rowCount;

      console.log(`[DEBUG]   Colonne: ${col.columnName}, cardinalité: ${col.cardinality}, ratio: ${cardinalityRatio.toFixed(3)}, exclue: ${isExcluded}`);

      if (
        col.dataType.toLowerCase().includes('varchar') &&
        !col.isLikelyKey &&
        !isExcluded &&
        col.cardinality > 1 &&
        col.cardinality <= 15 &&
        cardinalityRatio < maxRatio
      ) {
        console.log(`[DEBUG] ✅ CANDIDAT: ${sourceTable}.${col.columnName}`);
        candidates.add(`${sourceTable}.${col.columnName}`);
      }
    }
  }

  console.log(`[DEBUG] Total candidats: ${candidates.size}`);
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
  virtualFacts: VirtualFact[] = [],
  virtualDimensions: VirtualDimension[] = [],
  excludedColumns: Record<string, string[]> = {},
  columnTransformations: ColumnTransformation[] = [],
  tableRenames: TableRename[] = [],
  addedColumns: Record<string, { name: string; type: string }[]> = {},
): Record<string, { name: string; type: string }[]> {
  const attributes: Record<string, { name: string; type: string }[]> = {};

  const virtualFactNames = new Set(virtualFacts.map((vf) => vf.name));
  const virtualDimNames = new Set(virtualDimensions.map((vd) => vd.name));
  const allRealTables = [...cleanDimensions, ...cleanFacts].filter(
    (t) => !virtualFactNames.has(t) && !virtualDimNames.has(t),
  );

  for (const tableName of allRealTables) {
    const renameEntry = tableRenames.find((tr) => tr.displayName === tableName);
    const stagingLookupName = renameEntry ? renameEntry.stagingTable : tableName;

    const tableMeta = metadata.find((m) => m[0]?.sourceTable === stagingLookupName);
    if (tableMeta) {
      // ✅ CORRIGÉ (bug capture 1) : excludedColumns est stocké SANS préfixe staging
      // (ex: "Employees"), mais tableName ici garde le préfixe interne (ex: "staging_Employees").
      // On cherche donc sous les deux formes, sans jamais dépendre de la casse.
      const strippedTableName = this.stripPrefix(tableName);
      const excludedKey = Object.keys(excludedColumns ?? {}).find(
        (k) => this.stripPrefix(k).toLowerCase() === strippedTableName.toLowerCase(),
      );
      const excluded = new Set(
        (excludedKey ? excludedColumns[excludedKey] : []).map((c: string) => c.toLowerCase()),
      );

      const transformsForTable = columnTransformations.filter(
        (t) => this.stripPrefix(t.table).toLowerCase() === strippedTableName.toLowerCase(),
      );

      const baseColumns = tableMeta
        .filter((col) => !excluded.has(col.columnName.toLowerCase()))
        .map((col) => {
          const transform = transformsForTable.find((t) => t.originalColumn.toLowerCase() === col.columnName.toLowerCase());
          return transform
            ? { name: transform.newColumn, type: transform.newColumnType }
            : { name: col.columnName, type: col.dataType };
        });

      // ✅ NOUVEAU : ajoute les colonnes réellement nouvelles (sans équivalent d'origine)
      const addedKey = Object.keys(addedColumns ?? {}).find(
        (k) => this.stripPrefix(k).toLowerCase() === strippedTableName.toLowerCase(),
      );
      const extra = addedKey ? addedColumns[addedKey] : [];

      attributes[tableName] = [...baseColumns, ...extra];
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

  for (const vf of virtualFacts) {
    attributes[vf.name] = [
      { name: `${vf.name}Id`, type: 'INT' },
      ...vf.dimensionNames.map((d: string) => ({ name: `${d}Id`, type: 'INT' })),
      ...(vf.measures ?? []),
    ];
  }

  for (const vd of virtualDimensions) {
    attributes[vd.name] = [
      { name: `${vd.name}Id`, type: 'INT' },
      ...(vd.extraColumns ?? []),
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
      const subDimensions = await this.detectSubDimensions(metadata);

      const parsed = this.parseAiResponse(rawResponse) as any;

      const rejectedIndexes = new Set((parsed.rejectedRelationIndexes as number[]) ?? []);

      const selectedRelations = preFilterRelations
        .filter((_, i) => !rejectedIndexes.has(i))
        .map((r) => ({
          ...r,
          tableA: r.tableA.replace(/^staging_/i, ''),
          tableB: r.tableB.replace(/^staging_/i, ''),
        }));

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
        true, // ← génération initiale : chaque table du staging DOIT être classée
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
private readonly CACHE_TTL = 600000; // 1 minute

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

  const dateHint = hasDateColumn
    ? ' If relevant, add "DimTemps" to "dimensions" (it is generated automatically, do not worry about its columns or relations).'
    : '';

  return `BI expert. Tables:
${JSON.stringify(compactMetadata)}

Relations pré-détectées (numérotées) :
${numberedRelations.join('\n')}

TASK 1 — Classify each TABLE (not column) as dimension or fact.
"dimensions" and "facts" MUST contain table names ONLY, NEVER "table.column" format.${dateHint}

TASK 2 — All relations above are considered valid by default. ONLY list index numbers to REJECT in "rejectedRelationIndexes" if a relation is clearly wrong (e.g. connects two unrelated columns). If all relations look fine, leave it empty: [].

⚠️ Reply ONLY with valid JSON:
{"dimensions":[],"facts":[],"rejectedRelationIndexes":[]}`;
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
          num_predict: 4096,
          num_ctx: 4096, // ✅ NOUVEAU — évite la troncature silencieuse du prompt (défaut Ollama souvent 2048)
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
  rejectedRelationIndexes: unknown[];
  subDimensions: unknown[];
} {
  let cleaned = rawResponse
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim();

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    cleaned = jsonMatch[0];
  }

  const lastBrace = cleaned.lastIndexOf('}');
  if (lastBrace > 0 && lastBrace < cleaned.length - 1) {
    cleaned = cleaned.substring(0, lastBrace + 1);
  }

  // Réparer le pattern "clé:""valeur"" → "clé":"valeur"
  cleaned = cleaned.replace(/"(\w+):""([^"]*)""/g, '"$1":"$2"');

  try {
    const parsed = JSON.parse(cleaned);
    return {
      dimensions: parsed.dimensions ?? [],
      facts: parsed.facts ?? [],
      rejectedRelationIndexes: parsed.rejectedRelationIndexes ?? [],
      subDimensions: parsed.subDimensions ?? [],
    };
  } catch (e) {
    console.error('[parseAiResponse] Erreur parsing:', e.message);
    console.error('[parseAiResponse] cleaned:', cleaned.substring(0, 500));

    try {
      const repaired = cleaned.replace(/'/g, '"');
      const parsed = JSON.parse(repaired);
      return {
        dimensions: parsed.dimensions ?? [],
        facts: parsed.facts ?? [],
        rejectedRelationIndexes: parsed.rejectedRelationIndexes ?? [],
        subDimensions: parsed.subDimensions ?? [],
      };
    } catch (e2) {
      throw new InternalServerErrorException(
        `La réponse de l'IA n'est pas un JSON valide: ${e.message}`
      );
    }
  }
}

 private detectLikelyFactTables(metadata: ColumnMetadata[][]): string[] {
  const candidates: { name: string; score: number }[] = [];

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
    if (score >= 3) candidates.push({ name: tableName, score });
  }

  return candidates.sort((a, b) => b.score - a.score).map((c) => c.name);
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

      // ✅ REJET si hors liste de candidats calculée par le code
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
// private buildSubDimensionPrompt(candidateLabels: string[]): string {
//   return `From this list of candidates (format: table.column), pick the ones that represent a REAL business category (not personal names, IDs, or one-off attributes):

// ${candidateLabels.join('\n')}

// ✅ GOOD examples (pick these if they are in the list):
// - staging_Products.Category → {"name":"DimCategory","parentDimension":"staging_Products","sourceColumn":"Category"}
// - staging_Customers.Region → {"name":"DimRegion","parentDimension":"staging_Customers","sourceColumn":"Region"}
// - staging_Returns.ReturnReason → {"name":"DimReturnReason","parentDimension":"staging_Returns","sourceColumn":"ReturnReason"}

// ❌ BAD examples (DO NOT pick these):
// - staging_Employees.FirstName (personal name, not a business category)
// - staging_Products.ProductName (product name, not a category)
// - staging_Resellers.ResellerName (name, not a category)

// For each one you pick, split it into two fields:
// - part BEFORE the dot → "parentDimension"
// - part AFTER the dot → "sourceColumn"

// Reply ONLY with valid JSON, this exact format:
// {"subDimensions":[{"name":"DimCategory","parentDimension":"staging_Products","sourceColumn":"Category"}]}

// If none qualify, reply: {"subDimensions":[]}`;
// }

private buildSubDimensionPrompt(candidateLabels: string[]): string {
  // Construire un exemple dynamique
  let example = '';
  const exampleCount = Math.min(candidateLabels.length, 3);
  
  if (candidateLabels.length >= 2) {
    const examples = candidateLabels.slice(0, exampleCount).map(label => {
      const parts = label.split('.');
      const table = parts[0];
      const col = parts[1].split(' ')[0];
      return `{"name":"Dim${col}","parentDimension":"${table}","sourceColumn":"${col}"}`;
    });
    
    example = `
✅ EXAMPLE: It is NORMAL to pick MULTIPLE candidates (0, 1, 2, or more):
{"subDimensions":[${examples.join(', ')}]}`;
  } else if (candidateLabels.length === 1) {
    const first = candidateLabels[0];
    const parts = first.split('.');
    const table = parts[0];
    const col = parts[1].split(' ')[0];
    example = `
✅ EXAMPLE: If you think it's valid:
{"subDimensions":[{"name":"Dim${col}","parentDimension":"${table}","sourceColumn":"${col}"}]}`;
  }

  return `From this list of candidates (format: table.column), pick 0 or more that represent a REAL business category (not personal names, IDs, or one-off attributes):

${candidateLabels.join('\n')}
${example}

⚠️ REQUIRED FIELDS for EACH sub-dimension:
- "name": MUST start with "Dim" + the column name (e.g., "DimCountry")
- "parentDimension": the table name (part BEFORE the dot)
- "sourceColumn": the column name (part AFTER the dot)

❌ DO NOT forget "name" - it is MANDATORY!
❌ DO NOT send objects without "name"!

✅ CORRECT: {"name":"DimCountry","parentDimension":"staging_SalesTerritory","sourceColumn":"SalesTerritoryCountry"}
❌ INCORRECT: {"parentDimension":"staging_SalesTerritory","sourceColumn":"SalesTerritoryCountry"}

You can pick 0, 1, 2, or ALL candidates — it's perfectly normal to have multiple sub-dimensions.
If none qualify, reply: {"subDimensions":[]}

⚠️ Reply ONLY with valid JSON.`;
}

private async detectSubDimensions(metadata: ColumnMetadata[][]): Promise<any[]> {
  const candidateSet = this.getSubDimensionCandidateSet(metadata);
  if (candidateSet.size === 0) return [];

  const candidateLabels: string[] = [];
  for (const table of metadata) {
    for (const col of table) {
      if (candidateSet.has(`${col.sourceTable}.${col.columnName}`)) {
        candidateLabels.push(`${col.sourceTable}.${col.columnName} (${col.cardinality} valeurs distinctes)`);
      }
    }
  }

  const prompt = this.buildSubDimensionPrompt(candidateLabels);

  try {
    const rawResponse = await this.callOllama(prompt);
    let cleaned = rawResponse.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleaned = jsonMatch[0];
    cleaned = cleaned.replace(/"(\w+):""([^"]*)""/g, '"$1":"$2"');

    const parsed = JSON.parse(cleaned);
    return parsed.subDimensions ?? [];
  } catch (err) {
    console.warn('[detectSubDimensions] Échec, sous-dimensions ignorées:', err.message);
    return []; // en cas d'échec, on continue sans bloquer le schéma principal
  }
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
  parsed: { dimensions: unknown[]; facts: unknown[]; confirmedRelations: any[]; additionalRelations: any[]; subDimensions?: unknown[]; },
  validTableNames: Set<string>,
  validColumnsByTable: Map<string, Set<string>>,
  metadata: ColumnMetadata[][],
  enforceFullCoverage: boolean = true,
): Omit<AiSchemaProposal, 'rawResponse'> {
  const warnings: string[] = [];
  const hasDateColumn = metadata.some((table) => table.some((col) => col.dataType.toLowerCase().includes('date')));

  const normalizedValidColumns = new Map<string, Set<string>>();
  for (const [key, value] of validColumnsByTable.entries()) {
    const normalizedKey = this.stripPrefix(key);
    normalizedValidColumns.set(normalizedKey, value);
    normalizedValidColumns.set(key, value);
  }

  // --- 1. Normalisation des dimensions et faits ---
  const incomingVirtualFactNames = new Set(((parsed as any).virtualFacts ?? []).map((vf: any) => vf.name));
  const incomingVirtualDimNames = new Set(((parsed as any).virtualDimensions ?? []).map((vd: any) => vd.name));
  const incomingTableRenames: TableRename[] = (parsed as any).tableRenames ?? [];
  const renamedDisplayNames = new Set(incomingTableRenames.map((tr) => tr.displayName));

  // ✅ NOUVEAU : résout le nom staging d'origine d'une table (pour lookup de colonnes),
  // en tenant compte des renommages. Utilisé par structurallyValid ci-dessous.
  const resolveStagingNameForColumns = (t: string): string => {
    const renameEntry = incomingTableRenames.find((tr) => tr.displayName === t);
    return renameEntry ? this.stripPrefix(renameEntry.stagingTable) : t;
  };

  const isKnownOrDerived = (t: string, bucket: string): boolean => {
    if (validTableNames.has(t)) return true;
    if (this.isLegitimateDerivedDimension(t, hasDateColumn)) {
      warnings.push(`Dimension dérivée acceptée (générée, absente du staging): ${t}`);
      return true;
    }
    if (bucket === 'facts' && incomingVirtualFactNames.has(t)) {
      warnings.push(`Fait virtuel accepté (structure sans données source): ${t}`);
      return true;
    }
    if (bucket === 'dimensions' && incomingVirtualDimNames.has(t)) {
      warnings.push(`Dimension virtuelle acceptée (structure sans données source): ${t}`);
      return true;
    }
    if (renamedDisplayNames.has(t)) {
      warnings.push(`Table réelle renommée acceptée: ${t}`);
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

  if (enforceFullCoverage) {
    for (const tableName of validTableNames) {
      if (!seen.has(tableName)) {
        warnings.push(`Table ${tableName} non classée par l'IA — ajoutée en dimension par défaut`);
        cleanDimensions.push(tableName);
        seen.add(tableName);
      }
    }
  }

  const likelyFacts = this.detectLikelyFactTables(metadata);
  for (const candidate of likelyFacts) {
    if (cleanDimensions.includes(candidate) && !cleanFacts.includes(candidate)) {
      warnings.push(`${candidate} reclassée en fait par heuristique de secours (profil fort: clés étrangères + mesures)`);
      cleanDimensions.splice(cleanDimensions.indexOf(candidate), 1);
      cleanFacts.push(candidate);
    }
  }

  // Si AUCUN fait n'a pu être identifié, on construit automatiquement un fait virtuel
  let autoVirtualFacts: VirtualFact[] = [];
  let autoVirtualFactRelations: any[] = [];

  if (cleanFacts.length === 0 && cleanDimensions.length >= 2) {
    const factName = 'Fact';
    const strippedDimensionNames = cleanDimensions.map((d) => this.stripPrefix(d));

    warnings.push(
      `Aucune table de fait détectée parmi les tables uploadées — "${factName}" créée automatiquement, reliant toutes les dimensions (${strippedDimensionNames.join(', ')}). Cette table est vide et devra être peuplée manuellement.`,
    );

    cleanFacts.push(factName);
    autoVirtualFacts.push({ name: factName, dimensionNames: strippedDimensionNames });

    autoVirtualFactRelations = strippedDimensionNames.map((dim) => ({
      tableA: factName,
      columnA: `${dim}Id`,
      tableB: dim,
      columnB: `${dim}Id`,
      reason: 'fait_virtuel_genere_automatiquement',
    }));
  }

  // --- 2. Validation structurelle des relations ---
  const structurallyValid = (r: any): boolean => {
    if (!r || typeof r !== 'object') {
      warnings.push(`Relation ignorée (format invalide): ${JSON.stringify(r)}`);
      return false;
    }
    if (
      typeof r.tableA !== 'string' || typeof r.columnA !== 'string' ||
      typeof r.tableB !== 'string' || typeof r.columnB !== 'string' ||
      !r.tableA || !r.columnA || !r.tableB || !r.columnB
    ) {
      warnings.push(`Relation incomplète ou mal typée ignorée: ${JSON.stringify(r)}`);
      return false;
    }

    r.tableA = this.stripPrefix(r.tableA);
    r.tableB = this.stripPrefix(r.tableB);

    if (r.tableA.toLowerCase().includes('dimtemps') || r.tableB.toLowerCase().includes('dimtemps')) {
      warnings.push(`Relation vers DimTemps ignorée (générée automatiquement, pas par l'IA)`);
      return false;
    }

    if (
      r.reason === 'fait_virtuel_genere_via_chat' ||
      r.reason === 'fait_virtuel_genere_automatiquement' ||
      r.reason === 'dimension_virtuelle_generee_via_chat'
    ) return true;

    // ✅ CORRIGÉ (bug 4) : résout le nom staging d'origine avant le lookup de colonnes,
    // pour que les relations d'une table renommée ne soient plus rejetées à tort.
    const colsA = normalizedValidColumns.get(resolveStagingNameForColumns(r.tableA));
    if (!colsA || !colsA.has(r.columnA)) {
      warnings.push(`Relation invalide ignorée (colonne inexistante ${r.tableA}.${r.columnA})`);
      return false;
    }
    const colsB = normalizedValidColumns.get(resolveStagingNameForColumns(r.tableB));
    if (!colsB || !colsB.has(r.columnB)) {
      warnings.push(`Relation invalide ignorée (colonne inexistante ${r.tableB}.${r.columnB})`);
      return false;
    }
    return true;
  };

  // --- 3. Validation de la constellation ---
  const allRelationsRaw = [...parsed.confirmedRelations, ...parsed.additionalRelations, ...autoVirtualFactRelations].filter(structurallyValid);

  const cleanFactsStripped = new Set(cleanFacts.map((t) => this.stripPrefix(t)));
  const cleanDimensionsStripped = new Set(cleanDimensions.map((t) => this.stripPrefix(t)));

  const dimensionsLinkedToFact = new Set<string>();
  for (const r of allRelationsRaw) {
    const a = this.stripPrefix(r.tableA);
    const b = this.stripPrefix(r.tableB);
    if (cleanFactsStripped.has(a) && cleanDimensionsStripped.has(b)) dimensionsLinkedToFact.add(b);
    if (cleanFactsStripped.has(b) && cleanDimensionsStripped.has(a)) dimensionsLinkedToFact.add(a);
  }

  const isValidRelation = (r: any): boolean => {
    const a = this.stripPrefix(r.tableA);
    const b = this.stripPrefix(r.tableB);
    const aIsFact = cleanFactsStripped.has(a);
    const bIsFact = cleanFactsStripped.has(b);
    if (aIsFact || bIsFact) return true;

    const aLinked = dimensionsLinkedToFact.has(a);
    const bLinked = dimensionsLinkedToFact.has(b);
    if (aLinked && bLinked) {
      warnings.push(
        `Relation rejetée (${r.tableA} et ${r.tableB} sont toutes deux déjà reliées au fait — relation redondante/suspecte)`,
      );
      return false;
    }
    return true;
  };

  // --- 4. Construire les relations confirmées ---
  let confirmedRelations = [...parsed.confirmedRelations, ...autoVirtualFactRelations]
    .filter(structurallyValid)
    .filter(isValidRelation)
    .map((r: any) => ({ ...r, reason: r.reason || 'relation_confirmee_par_ia' }));

  let additionalRelations = parsed.additionalRelations
    .filter(structurallyValid)
    .filter(isValidRelation)
    .map((r: any) => ({ ...r, reason: r.reason || 'relation_additionnelle' }));

  // --- 5. Validation des sous-dimensions ---
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
  const subDimensionNames = new Set(subDimensions.map((sd) => sd.name));

  confirmedRelations = confirmedRelations.filter(
    (r: any) => !subDimensionNames.has(r.tableA) && !subDimensionNames.has(r.tableB),
  );
  additionalRelations = additionalRelations.filter(
    (r: any) => !subDimensionNames.has(r.tableA) && !subDimensionNames.has(r.tableB),
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
    // --- 8. Génération automatique de DimTemps ---
  // ✅ CORRIGÉ (bug capture 2) : après un renommage de table, cleanFacts contient le
  // NOUVEAU nom ("sales"), qui ne correspond plus à aucun sourceTable des métadonnées
  // ("staging_FactSales"). On résout donc le vrai nom staging via tableRenames avant
  // de chercher la colonne date, sinon DimTemps et sa relation sont recréés vides.
  const resolveOriginalStagingSourceName = (name: string): string => {
    const stripped = this.stripPrefix(name);
    const renameEntry = incomingTableRenames.find(
      (tr) => tr.displayName.toLowerCase() === stripped.toLowerCase() || tr.displayName.toLowerCase() === name.toLowerCase(),
    );
    return renameEntry ? this.stripPrefix(renameEntry.stagingTable) : stripped;
  };

  const factsWithDate = cleanFacts
    .map((factName) => {
      const resolvedName = resolveOriginalStagingSourceName(factName);
      const factMeta = metadata.find((table) => this.stripPrefix(table[0]?.sourceTable ?? '').toLowerCase() === resolvedName.toLowerCase());
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
  } else if (dimTempsPresent && factsWithDate.length === 0) {
    // ✅ NOUVEAU : trace explicite si DimTemps existe mais qu'aucune colonne date n'a pu
    // être retrouvée pour aucun fait — utile pour diagnostiquer un futur cas similaire.
    warnings.push(
      `DimTemps présente dans le schéma mais aucune colonne date retrouvée pour les faits actuels (${cleanFacts.join(', ')}) — vérifie les renommages de tables.`,
    );
  }

  // --- 8.5. Purge des relations vers des tables non classées ---
  const classifiedStripped = new Set([
    ...cleanDimensions.map((t) => this.stripPrefix(t)),
    ...cleanFacts.map((t) => this.stripPrefix(t)),
    ...subDimensions.map((sd) => sd.name),
  ]);
  const isFullyClassified = (r: any): boolean => {
    const a = this.stripPrefix(r.tableA);
    const b = this.stripPrefix(r.tableB);
    return classifiedStripped.has(a) && classifiedStripped.has(b);
  };
  const finalConfirmedRelationsClean = finalConfirmedRelations.filter(isFullyClassified);
  const additionalRelationsClean = additionalRelations.filter(isFullyClassified);

  // --- 9. Fallback : si aucune relation n'a été proposée par l'IA ---
  if (finalConfirmedRelationsClean.length === 0 && additionalRelationsClean.length === 0) {
    warnings.push("Aucune relation proposée par l'IA - utilisation des relations pré-détectées par heuristique");

    const preFilterRelations = this.uploadService.detectCrossTableRelations(metadata);
    let fallbackCount = 0;

    for (const rel of preFilterRelations) {
      const tableA = this.stripPrefix(rel.tableA);
      const tableB = this.stripPrefix(rel.tableB);

      const aExists = cleanDimensions.includes(tableA) || cleanFacts.includes(tableA);
      const bExists = cleanDimensions.includes(tableB) || cleanFacts.includes(tableB);

      if (aExists && bExists) {
        const colsA = normalizedValidColumns.get(tableA);
        const colsB = normalizedValidColumns.get(tableB);

        if (colsA?.has(rel.columnA) && colsB?.has(rel.columnB)) {
          const isDuplicate = finalConfirmedRelationsClean.some(
            (r: any) => r.tableA === tableA && r.columnA === rel.columnA && r.tableB === tableB && r.columnB === rel.columnB,
          );

          if (!isDuplicate) {
            finalConfirmedRelationsClean.push({
              tableA,
              columnA: rel.columnA,
              tableB,
              columnB: rel.columnB,
              reason: 'relation_pre_detectee_par_heuristique',
            });
            fallbackCount++;
          }
        }
      }
    }

    if (fallbackCount > 0) {
      warnings.push(`${fallbackCount} relations récupérées via le fallback heuristique`);
    } else {
      warnings.push("Aucune relation n'a pu être récupérée via le fallback");
    }
  }

  // --- 10. Construction des attributs des tables ---
  const virtualFacts: VirtualFact[] = [...((parsed as any).virtualFacts ?? []), ...autoVirtualFacts];
  const virtualDimensions: VirtualDimension[] = (parsed as any).virtualDimensions ?? [];

  const columnTransformations: ColumnTransformation[] = (parsed as any).columnTransformations ?? [];
  const excludedColumns = (parsed as any).excludedColumns ?? {};
  const addedColumns: Record<string, { name: string; type: string }[]> = (parsed as any).addedColumns ?? {}; // ✅ NOUVEAU

  const tableAttributes = this.buildTableAttributes(
    cleanDimensions,
    cleanFacts,
    metadata,
    generatedDimensions,
    subDimensions,
    virtualFacts,
    virtualDimensions,
    excludedColumns,
    columnTransformations,
    incomingTableRenames,
    addedColumns, // ✅ NOUVEAU
  );

  return {
    dimensions: cleanDimensions,
    facts: cleanFacts,
    confirmedRelations: finalConfirmedRelationsClean,
    additionalRelations: additionalRelationsClean,
    generatedDimensions,
    factColumnTransformations,
    subDimensions,
    tableAttributes,
    virtualFacts,
    virtualDimensions,
    excludedColumns,
    columnTransformations,
    tableRenames: incomingTableRenames,
    addedColumns, // ✅ NOUVEAU
    warnings,
  };
}
// private buildChatPrompt(currentSchema: any, userMessage: string): string {
//   return `Tu es un assistant qui aide à valider un schéma de data warehouse en dialoguant avec l'utilisateur.

// Schéma actuel :
// ${JSON.stringify({ dimensions: currentSchema.dimensions, facts: currentSchema.facts, confirmedRelations: currentSchema.confirmedRelations, subDimensions: currentSchema.subDimensions, tableAttributes: currentSchema.tableAttributes })}

// Message de l'utilisateur : "${userMessage}"

// Réponds à sa question ou sa demande de façon naturelle et utile, en français.

// ⚠️ IMPORTANT : détermine d'abord si le message est une SIMPLE QUESTION (ne demande aucune modification, juste une explication) ou une DEMANDE DE MODIFICATION explicite (déplacer une table, ajouter/retirer une relation).

// - Si c'est une SIMPLE QUESTION : mets "schemaChanged": false, et NE RENVOIE PAS les champs "dimensions"/"facts"/"confirmedRelations" (laisse-les absents ou vides).
// - Si c'est une DEMANDE DE MODIFICATION : applique-la en respectant ces règles, mets "schemaChanged": true, et renvoie les champs complets et mis à jour :
//   - INTERDIT : ne propose jamais de relation directe entre deux dimensions qui sont TOUTES LES DEUX déjà reliées directement à une table de faits.
//   - Le schéma peut avoir PLUSIEURS tables de faits (constellation) si l'utilisateur le demande — dans ce cas, veille à ce qu'au moins une dimension reste reliée aux différentes tables de faits.
//   - N'invente jamais de nom de table ou de colonne qui n'existe pas déjà dans le schéma actuel ou les métadonnées d'origine.
//   - Ne modifie jamais "DimTemps" ni ses relations — cette dimension est gérée automatiquement, ignore toute demande à son sujet et explique-le à l'utilisateur si besoin.

// Réponds STRICTEMENT en JSON avec ce format :
// {"reply":"ta réponse conversationnelle à l'utilisateur","schemaChanged":false,"dimensions":[],"facts":[],"confirmedRelations":[],"subDimensions":[]}`;
// }

private applyChatAction(
  currentSchema: any,
  action: any,
  userMessage: string,
): { newSchema: any; deterministicExplanation: string; changed: boolean } {
  const schema = JSON.parse(JSON.stringify(currentSchema)); // clone profond, on ne touche rien d'autre

  switch (action.action) {
    case 'none': {
      return { newSchema: schema, deterministicExplanation: '', changed: false };
    }

    case 'move_to_fact': {
      const table = action.table;
      if (!schema.dimensions?.includes(table)) {
        return { newSchema: schema, deterministicExplanation: `Table "${table}" introuvable en dimension, aucun changement.`, changed: false };
      }
      schema.dimensions = schema.dimensions.filter((t: string) => t !== table);
      schema.facts = [...(schema.facts ?? []), table];
      return { newSchema: schema, deterministicExplanation: `${table} déplacée de dimension vers fait.`, changed: true };
    }

    case 'move_to_dimension': {
      const table = action.table;
      if (!schema.facts?.includes(table)) {
        return { newSchema: schema, deterministicExplanation: `Table "${table}" introuvable en fait, aucun changement.`, changed: false };
      }
      schema.facts = schema.facts.filter((t: string) => t !== table);
      schema.dimensions = [...(schema.dimensions ?? []), table];
      return { newSchema: schema, deterministicExplanation: `${table} déplacée de fait vers dimension.`, changed: true };
    }

    case 'remove_dimension': {
  const table = action.table;
  if (!schema.dimensions?.includes(table)) {
    return { newSchema: schema, deterministicExplanation: `Table "${table}" introuvable en dimension, aucun changement.`, changed: false };
  }

  schema.dimensions = schema.dimensions.filter((t: string) => t !== table);

  const removedRelationsCount = (schema.confirmedRelations ?? []).filter(
    (r: any) => r.tableA === table || r.tableB === table,
  ).length;
  schema.confirmedRelations = (schema.confirmedRelations ?? []).filter(
    (r: any) => r.tableA !== table && r.tableB !== table,
  );

  const orphanedSubDims = (schema.subDimensions ?? []).filter((sd: any) => sd.parentDimension === table);
  schema.subDimensions = (schema.subDimensions ?? []).filter((sd: any) => sd.parentDimension !== table);

  let explanation = `${table} retirée du Data Warehouse (renvoyée en staging non classé).`;
  if (removedRelationsCount > 0) explanation += ` ${removedRelationsCount} relation(s) supprimée(s).`;
  if (orphanedSubDims.length > 0) {
    explanation += ` ${orphanedSubDims.length} sous-dimension(s) orpheline(s) également retirée(s) : ${orphanedSubDims.map((sd: any) => sd.name).join(', ')}.`;
  }

  return { newSchema: schema, deterministicExplanation: explanation, changed: true };
}

case 'remove_fact': {
  const table = action.table;
  if (!schema.facts?.includes(table)) {
    return { newSchema: schema, deterministicExplanation: `Table "${table}" introuvable en fait, aucun changement.`, changed: false };
  }

  schema.facts = schema.facts.filter((t: string) => t !== table);

  const removedRelationsCount = (schema.confirmedRelations ?? []).filter(
    (r: any) => r.tableA === table || r.tableB === table,
  ).length;
  schema.confirmedRelations = (schema.confirmedRelations ?? []).filter(
    (r: any) => r.tableA !== table && r.tableB !== table,
  );

  // Purge les transformations DimTemps liées à ce fait
  const removedTransformationsCount = (schema.factColumnTransformations ?? []).filter(
    (t: any) => t.factTable === table,
  ).length;
  schema.factColumnTransformations = (schema.factColumnTransformations ?? []).filter(
    (t: any) => t.factTable !== table,
  );

  const dimTempsStillUsed = (schema.factColumnTransformations ?? []).some(
    (t: any) => t.referencesTable === 'DimTemps',
  );
  let dimTempsRemoved = false;
  if (!dimTempsStillUsed && schema.generatedDimensions?.some((gd: any) => gd.name === 'DimTemps')) {
    schema.generatedDimensions = schema.generatedDimensions.filter((gd: any) => gd.name !== 'DimTemps');
    schema.dimensions = (schema.dimensions ?? []).filter((d: string) => !d.toLowerCase().includes('dimtemps'));
    dimTempsRemoved = true;
  }

  // ✅ NOUVEAU : retire les dimensions restantes qui n'ont plus AUCUNE relation avec un fait
  // (elles étaient liées uniquement au fait qu'on vient de supprimer).
  const remainingFacts = new Set(schema.facts ?? []);
  const orphanedDimensions = (schema.dimensions ?? []).filter((dim: string) => {
    const hasRelationToAnyFact = (schema.confirmedRelations ?? []).some(
      (r: any) =>
        (r.tableA === dim && remainingFacts.has(r.tableB)) ||
        (r.tableB === dim && remainingFacts.has(r.tableA)),
    );
    return !hasRelationToAnyFact;
  });

  let orphanCascadeExplanation = '';
  for (const orphanTable of orphanedDimensions) {
    schema.dimensions = schema.dimensions.filter((t: string) => t !== orphanTable);
    schema.confirmedRelations = (schema.confirmedRelations ?? []).filter(
      (r: any) => r.tableA !== orphanTable && r.tableB !== orphanTable,
    );
    const orphanedSubDims = (schema.subDimensions ?? []).filter((sd: any) => sd.parentDimension === orphanTable);
    schema.subDimensions = (schema.subDimensions ?? []).filter((sd: any) => sd.parentDimension !== orphanTable);
    if (orphanedSubDims.length > 0) {
      orphanCascadeExplanation += ` ${orphanTable} et ses sous-dimension(s) (${orphanedSubDims.map((sd: any) => sd.name).join(', ')}) retirée(s) car sans relation restante.`;
    } else {
      orphanCascadeExplanation += ` ${orphanTable} retirée car sans relation restante.`;
    }
  }

  let explanation = `${table} retirée du Data Warehouse.`;
  if (removedRelationsCount > 0) explanation += ` ${removedRelationsCount} relation(s) supprimée(s).`;
  if (removedTransformationsCount > 0) explanation += ` ${removedTransformationsCount} transformation(s) de date supprimée(s).`;
  if (dimTempsRemoved) explanation += ` DimTemps retirée (plus aucun fait ne l'utilise).`;
  if (orphanCascadeExplanation) explanation += orphanCascadeExplanation;

  return { newSchema: schema, deterministicExplanation: explanation, changed: true };
}
    case 'add_relation': {
      const exists = (schema.confirmedRelations ?? []).some(
        (r: any) => r.tableA === action.tableA && r.columnA === action.columnA && r.tableB === action.tableB && r.columnB === action.columnB,
      );
      if (exists) {
        return { newSchema: schema, deterministicExplanation: 'Cette relation existe déjà.', changed: false };
      }
      schema.confirmedRelations = [
        ...(schema.confirmedRelations ?? []),
        { tableA: action.tableA, columnA: action.columnA, tableB: action.tableB, columnB: action.columnB, reason: 'ajoutee_via_chat' },
      ];
      return { newSchema: schema, deterministicExplanation: `Relation ajoutée : ${action.tableA}.${action.columnA} ↔ ${action.tableB}.${action.columnB}.`, changed: true };
    }

    case 'remove_relation': {
      const before = (schema.confirmedRelations ?? []).length;
      schema.confirmedRelations = (schema.confirmedRelations ?? []).filter(
        (r: any) => !(r.tableA === action.tableA && r.columnA === action.columnA && r.tableB === action.tableB && r.columnB === action.columnB),
      );
      const changed = schema.confirmedRelations.length !== before;
      return {
        newSchema: schema,
        deterministicExplanation: changed ? `Relation supprimée : ${action.tableA}.${action.columnA} ↔ ${action.tableB}.${action.columnB}.` : 'Relation introuvable, aucun changement.',
        changed,
      };
    }

    case 'remove_subdimension': {
      const before = (schema.subDimensions ?? []).length;
      schema.subDimensions = (schema.subDimensions ?? []).filter((sd: any) => sd.name !== action.name);
      const changed = schema.subDimensions.length !== before;
      return {
        newSchema: schema,
        deterministicExplanation: changed ? `Sous-dimension ${action.name} supprimée.` : 'Sous-dimension introuvable, aucun changement.',
        changed,
      };
    }


case 'create_fact_table': {
  let dimensions: string[] = Array.isArray(action.dimensions) ? action.dimensions : [];
  dimensions = dimensions.map((d: string) => this.stripPrefix(d));

  const schemaDimensionsStripped = (schema.dimensions ?? []).map((d: string) => this.stripPrefix(d));

  // ✅ CORRIGÉ : correspondance insensible à la casse/espaces, au lieu d'une comparaison stricte,
  // pour éviter que "Product" (au lieu de "Products") ne fasse basculer sur TOUTES les dimensions.
  const normalize = (s: string) => s.toLowerCase().replace(/[_\s-]/g, '');
  let validDimensions = dimensions
    .map((d: string) => schemaDimensionsStripped.find((real: string) => normalize(real) === normalize(d)))
    .filter((d): d is string => d !== undefined);

  // Dédoublonne au cas où le modèle aurait listé deux fois la même dimension
  validDimensions = [...new Set(validDimensions)];

  if (validDimensions.length < 2) {
    console.warn(`[applyChatAction] create_fact_table: dimensions demandées non reconnues (${dimensions.join(', ')}) — fallback sur toutes les dimensions du schéma.`);
    validDimensions = [...schemaDimensionsStripped];
  }

  if (validDimensions.length < 2) {
    return {
      newSchema: schema,
      deterministicExplanation: `Impossible de créer le fait : au moins 2 dimensions sont nécessaires dans le schéma (trouvé: ${validDimensions.length}).`,
      changed: false,
    };
  }

  // ✅ CORRIGÉ : utilise le nom demandé par l'utilisateur s'il est fourni et disponible,
  // sinon retombe sur la génération automatique "Fact"/"Fact2"/...
  let factName: string;
  const requestedName = (action.name && typeof action.name === 'string' && action.name.trim())
    ? action.name.trim()
    : null;

  if (requestedName && !schema.facts?.includes(requestedName) && !schema.dimensions?.includes(requestedName)) {
    factName = requestedName;
  } else if (requestedName) {
    return { newSchema: schema, deterministicExplanation: `Le nom "${requestedName}" est déjà utilisé, aucun changement.`, changed: false };
  } else {
    factName = 'Fact';
    let suffix = 2;
    while (schema.facts?.includes(factName) || schema.dimensions?.includes(factName)) {
      factName = `Fact${suffix}`;
      suffix++;
    }
  }

  const rawMeasures = Array.isArray(action.measures)
    ? action.measures.filter((m: any) => m && typeof m.name === 'string' && typeof m.type === 'string')
    : [];
  const normalizedMessage = normalize(userMessage);
  const measures = rawMeasures.filter((m: any) => normalizedMessage.includes(normalize(m.name)));
  const rejectedMeasures = rawMeasures.filter((m: any) => !normalizedMessage.includes(normalize(m.name)));
  if (rejectedMeasures.length > 0) {
    console.warn(`[applyChatAction] Mesures rejetées (non mentionnées dans le message): ${rejectedMeasures.map((m: any) => m.name).join(', ')}`);
  }

  schema.facts = [...(schema.facts ?? []), factName];
  schema.virtualFacts = [...(schema.virtualFacts ?? []), { name: factName, dimensionNames: validDimensions, measures }];

  const newRelations = validDimensions.map((dim: string) => ({
    tableA: factName,
    columnA: `${dim}Id`,
    tableB: dim,
    columnB: `${dim}Id`,
    reason: 'fait_virtuel_genere_via_chat',
  }));
  schema.confirmedRelations = [...(schema.confirmedRelations ?? []), ...newRelations];

  const measuresNote = measures.length > 0
    ? ` Mesures ajoutées : ${measures.map((m: any) => `${m.name} (${m.type})`).join(', ')}.`
    : '';

  return {
    newSchema: schema,
    deterministicExplanation: `Table de fait "${factName}" créée avec des clés étrangères vers ${validDimensions.join(', ')}.${measuresNote} Elle est vide (aucune source de données) — à peupler manuellement plus tard.`,
    changed: true,
  };
}

case 'create_dimension': {
  const dimName = (action.name && typeof action.name === 'string' && action.name.trim())
    ? action.name.trim()
    : null;

  if (!dimName) {
    return { newSchema: schema, deterministicExplanation: `Nom de dimension manquant, aucun changement.`, changed: false };
  }

  if (schema.dimensions?.includes(dimName) || schema.facts?.includes(dimName)) {
    return { newSchema: schema, deterministicExplanation: `Le nom "${dimName}" est déjà utilisé, aucun changement.`, changed: false };
  }

  const linkedFact = this.stripPrefix(action.linkedFact ?? '');
  const schemaFactsStripped = (schema.facts ?? []).map((f: string) => this.stripPrefix(f));

  if (!linkedFact || !schemaFactsStripped.includes(linkedFact)) {
    return {
      newSchema: schema,
      deterministicExplanation: `Impossible de créer "${dimName}" : aucun fait valide précisé pour la relier (une dimension virtuelle doit obligatoirement être reliée à un fait existant).`,
      changed: false,
    };
  }

  const realFactName = (schema.facts ?? []).find((f: string) => this.stripPrefix(f) === linkedFact);

  const rawExtraColumns = Array.isArray(action.columns)
    ? action.columns.filter((c: any) => c && typeof c.name === 'string' && typeof c.type === 'string')
    : [];

  const normalize = (s: string) => s.toLowerCase().replace(/[_\s-]/g, '');
  const normalizedMessage = normalize(userMessage);

  const extraColumns = rawExtraColumns.filter((c: any) => normalizedMessage.includes(normalize(c.name)));

  const rejectedColumns = rawExtraColumns.filter((c: any) => !normalizedMessage.includes(normalize(c.name)));
  if (rejectedColumns.length > 0) {
    console.warn(`[applyChatAction] Colonnes rejetées (non mentionnées dans le message): ${rejectedColumns.map((c: any) => c.name).join(', ')}`);
  }

  schema.dimensions = [...(schema.dimensions ?? []), dimName];
  schema.virtualDimensions = [
    ...(schema.virtualDimensions ?? []),
    { name: dimName, linkedFact: linkedFact, extraColumns },
  ];

  schema.confirmedRelations = [
    ...(schema.confirmedRelations ?? []),
    {
      tableA: realFactName,
      columnA: `${dimName}Id`,
      tableB: dimName,
      columnB: `${dimName}Id`,
      reason: 'dimension_virtuelle_generee_via_chat',
    },
  ];

  // ✅ NOUVEAU : synchronise virtualFacts.dimensionNames si le fait cible est un fait virtuel.
  // Sans ça, DwTableSchemaResolver.GetColumns (côté C#) ne créera jamais la colonne
  // {dimName}Id sur ce fait, car elle est dérivée de cette liste statique et non des relations.
  const realFactStripped = this.stripPrefix(realFactName);
  schema.virtualFacts = (schema.virtualFacts ?? []).map((vf: any) =>
    this.stripPrefix(vf.name) === realFactStripped
      ? { ...vf, dimensionNames: [...vf.dimensionNames, dimName] }
      : vf,
  );

  const columnsNote = extraColumns.length > 0
    ? ` Colonnes ajoutées : ${extraColumns.map((c: any) => `${c.name} (${c.type})`).join(', ')}.`
    : '';

  return {
    newSchema: schema,
    deterministicExplanation: `Dimension "${dimName}" créée (vide, à peupler manuellement) et reliée à "${linkedFact}".${columnsNote}`,
    changed: true,
  };
}

case 'remove_dimension_column': {
  const dimName = action.dimension;
  const colName = action.column;

  // Cas 1 : dimension virtuelle -> retire la colonne de virtualDimensions
  const vd = (schema.virtualDimensions ?? []).find((v: any) => v.name.toLowerCase() === String(dimName).toLowerCase());
  if (vd) {
    const before = (vd.extraColumns ?? []).length;
    vd.extraColumns = (vd.extraColumns ?? []).filter((c: any) => c.name.toLowerCase() !== String(colName).toLowerCase());
    const changed = vd.extraColumns.length !== before;
    schema.virtualDimensions = (schema.virtualDimensions ?? []).map((v: any) => (v.name === vd.name ? vd : v));
    return {
      newSchema: schema,
      deterministicExplanation: changed ? `Colonne "${colName}" supprimée de la dimension virtuelle "${vd.name}".` : `Colonne "${colName}" introuvable dans "${vd.name}", aucun changement.`,
      changed,
    };
  }

  // Cas 2 : dimension réelle -> exclut la colonne du DW final (données conservées en staging)
  // ✅ CORRIGÉ (bug capture 1) : recherche insensible à la casse, et on garde le nom RÉEL
  // trouvé (avec sa casse d'origine) comme clé de stockage, pour que buildTableAttributes
  // puisse la retrouver de façon fiable (via stripPrefix + lowercase des deux côtés).
  const realDimMatch = (schema.dimensions ?? []).find(
    (d: string) => this.stripPrefix(d).toLowerCase() === this.stripPrefix(dimName).toLowerCase(),
  );
  if (!realDimMatch) {
    return { newSchema: schema, deterministicExplanation: `Dimension "${dimName}" introuvable, aucun changement.`, changed: false };
  }

  const strippedDim = this.stripPrefix(realDimMatch);
  schema.excludedColumns = schema.excludedColumns ?? {};
  const currentExcluded = schema.excludedColumns[strippedDim] ?? [];
  if (currentExcluded.some((c: string) => c.toLowerCase() === String(colName).toLowerCase())) {
    return { newSchema: schema, deterministicExplanation: `Colonne "${colName}" déjà exclue de "${dimName}".`, changed: false };
  }

  schema.excludedColumns[strippedDim] = [...currentExcluded, colName];

  return {
    newSchema: schema,
    deterministicExplanation: `Colonne "${colName}" exclue de la dimension "${dimName}" dans le Data Warehouse (elle reste dans le staging).`,
    changed: true,
  };
}

case 'add_dimension_column': {
  const dimName = action.dimension;
  const column = { name: action.columnName, type: action.columnType };

  if (typeof column.name !== 'string' || typeof column.type !== 'string' || !column.name || !column.type) {
    return { newSchema: schema, deterministicExplanation: `Colonne mal spécifiée, aucun changement.`, changed: false };
  }

  // ✅ Même garde-fou anti-hallucination que create_dimension : le nom de la colonne
  // doit réellement apparaître dans le message utilisateur.
  const normalize = (s: string) => s.toLowerCase().replace(/[_\s-]/g, '');
  const normalizedMessage = normalize(userMessage);
  if (!normalizedMessage.includes(normalize(column.name))) {
    console.warn(`[applyChatAction] Colonne "${column.name}" rejetée : non mentionnée dans le message "${userMessage}"`);
    return { newSchema: schema, deterministicExplanation: `Impossible de confirmer la colonne "${column.name}" à partir du message, aucun changement.`, changed: false };
  }

  const vd = (schema.virtualDimensions ?? []).find((v: any) => v.name.toLowerCase() === String(dimName).toLowerCase());
  if (!vd) {
    return { newSchema: schema, deterministicExplanation: `Dimension virtuelle "${dimName}" introuvable, aucun changement.`, changed: false };
  }

  const alreadyExists = (vd.extraColumns ?? []).some((c: any) => c.name.toLowerCase() === column.name.toLowerCase());
  if (alreadyExists) {
    return { newSchema: schema, deterministicExplanation: `La colonne "${column.name}" existe déjà dans "${vd.name}", aucun changement.`, changed: false };
  }

  vd.extraColumns = [...(vd.extraColumns ?? []), { name: column.name, type: column.type }];
  schema.virtualDimensions = (schema.virtualDimensions ?? []).map((v: any) => (v.name === vd.name ? vd : v));

  return {
    newSchema: schema,
    deterministicExplanation: `Colonne "${column.name}" (${column.type}) ajoutée à la dimension "${vd.name}".`,
    changed: true,
  };
}
case 'add_real_column': {
  const tableName = action.table;
  const column = { name: action.columnName, type: action.columnType };

  if (typeof column.name !== 'string' || typeof column.type !== 'string' || !column.name || !column.type) {
    return { newSchema: schema, deterministicExplanation: `Colonne mal spécifiée, aucun changement.`, changed: false };
  }

  const strippedTable = this.stripPrefix(tableName);
  const isRealDim = (schema.dimensions ?? []).some((d: string) => this.stripPrefix(d).toLowerCase() === strippedTable.toLowerCase());
  const isRealFact = (schema.facts ?? []).some((f: string) => this.stripPrefix(f).toLowerCase() === strippedTable.toLowerCase());
  const isVirtual = (schema.virtualDimensions ?? []).some((vd: any) => vd.name.toLowerCase() === strippedTable.toLowerCase())
    || (schema.virtualFacts ?? []).some((vf: any) => vf.name.toLowerCase() === strippedTable.toLowerCase());

  if ((!isRealDim && !isRealFact) || isVirtual) {
    return {
      newSchema: schema,
      deterministicExplanation: `Table réelle "${tableName}" introuvable (utilise add_dimension_column/add_fact_column pour une table virtuelle), aucun changement.`,
      changed: false,
    };
  }

  const normalize = (s: string) => s.toLowerCase().replace(/[_\s-]/g, '');
  if (!normalize(userMessage).includes(normalize(column.name))) {
    console.warn(`[applyChatAction] add_real_column: colonne "${column.name}" rejetée, non mentionnée dans "${userMessage}"`);
    return { newSchema: schema, deterministicExplanation: `Impossible de confirmer la colonne "${column.name}" à partir du message, aucun changement.`, changed: false };
  }

  // Vérifie qu'une colonne de ce nom n'existe pas déjà réellement dans le staging
  const existingAttrs = (schema.tableAttributes ?? {})[strippedTable]
    ?? (schema.tableAttributes ?? {})[tableName]
    ?? [];
  const alreadyExistsInStaging = existingAttrs.some((a: any) => a.name.toLowerCase() === column.name.toLowerCase());
  if (alreadyExistsInStaging) {
    return {
      newSchema: schema,
      deterministicExplanation: `La colonne "${column.name}" existe déjà dans "${tableName}" — utilise plutôt un renommage/changement de type si tu veux la modifier.`,
      changed: false,
    };
  }

  schema.addedColumns = schema.addedColumns ?? {};
  const current = schema.addedColumns[strippedTable] ?? [];
  if (current.some((c: any) => c.name.toLowerCase() === column.name.toLowerCase())) {
    return { newSchema: schema, deterministicExplanation: `La colonne "${column.name}" est déjà présente dans "${tableName}", aucun changement.`, changed: false };
  }
  schema.addedColumns[strippedTable] = [...current, column];

  return {
    newSchema: schema,
    deterministicExplanation: `Colonne "${column.name}" (${column.type}) ajoutée à "${tableName}" (colonne vide, à peupler manuellement).`,
    changed: true,
  };
}

case 'rename_table': {
  const oldName = action.oldName;
  const newName = (action.newName && typeof action.newName === 'string' && action.newName.trim())
    ? action.newName.trim()
    : null;

  if (!newName) {
    return { newSchema: schema, deterministicExplanation: `Nouveau nom manquant, aucun changement.`, changed: false };
  }

  const isDimension = schema.dimensions?.includes(oldName);
  const isFact = schema.facts?.includes(oldName);

  if (!isDimension && !isFact) {
    return { newSchema: schema, deterministicExplanation: `Table "${oldName}" introuvable, aucun changement.`, changed: false };
  }

  if (schema.dimensions?.includes(newName) || schema.facts?.includes(newName)) {
    return { newSchema: schema, deterministicExplanation: `Le nom "${newName}" est déjà utilisé, aucun changement.`, changed: false };
  }

  if (newName.toLowerCase().includes('dimtemps') || oldName.toLowerCase() === 'dimtemps') {
    return { newSchema: schema, deterministicExplanation: `Impossible de renommer "${oldName}" : ce nom est réservé au mécanisme automatique de dimension temporelle.`, changed: false };
  }

  // ✅ NOUVEAU : pour une table RÉELLE (pas virtuelle), on garde la trace de son vrai nom
  // staging d'origine. Sans ça, validateAndClean rejette le nouveau nom comme "table inventée"
  // (il ne correspond plus à aucune table du staging), et la table disparaît du schéma.
  const isVirtualDim = schema.virtualDimensions?.some((vd: any) => vd.name === oldName);
  const isVirtualFact = schema.virtualFacts?.some((vf: any) => vf.name === oldName);

  if (!isVirtualDim && !isVirtualFact) {
    // Gère les renommages en chaîne : si "oldName" est déjà un nom d'affichage issu
    // d'un renommage précédent, on retrouve le VRAI nom staging d'origine.
    const existingRename = (schema.tableRenames ?? []).find((tr: any) => tr.displayName === oldName);
    const stagingTable = existingRename ? existingRename.stagingTable : oldName;

    schema.tableRenames = [
      ...(schema.tableRenames ?? []).filter((tr: any) => tr.displayName !== oldName),
      { stagingTable, displayName: newName },
    ];
  }

  schema.dimensions = (schema.dimensions ?? []).map((d: string) => (d === oldName ? newName : d));
  schema.facts = (schema.facts ?? []).map((f: string) => (f === oldName ? newName : f));

  const renameInRelations = (relations: any[]) =>
    (relations ?? []).map((r: any) => ({
      ...r,
      tableA: r.tableA === oldName ? newName : r.tableA,
      tableB: r.tableB === oldName ? newName : r.tableB,
    }));
  schema.confirmedRelations = renameInRelations(schema.confirmedRelations);
  schema.additionalRelations = renameInRelations(schema.additionalRelations);

  schema.virtualDimensions = (schema.virtualDimensions ?? []).map((vd: any) => ({
    ...vd,
    name: vd.name === oldName ? newName : vd.name,
    linkedFact: vd.linkedFact === oldName ? newName : vd.linkedFact,
  }));

  schema.virtualFacts = (schema.virtualFacts ?? []).map((vf: any) => ({
    ...vf,
    name: vf.name === oldName ? newName : vf.name,
    dimensionNames: (vf.dimensionNames ?? []).map((d: string) => (d === oldName ? newName : d)),
  }));

  schema.subDimensions = (schema.subDimensions ?? []).map((sd: any) => ({
    ...sd,
    parentDimension: sd.parentDimension === oldName ? newName : sd.parentDimension,
  }));

  schema.factColumnTransformations = (schema.factColumnTransformations ?? []).map((t: any) => ({
    ...t,
    factTable: t.factTable === oldName ? newName : t.factTable,
  }));

  // ✅ NOUVEAU : propage le renommage aux transformations de colonnes déjà existantes sur cette table
  schema.columnTransformations = (schema.columnTransformations ?? []).map((t: any) => ({
    ...t,
    table: t.table === oldName ? newName : t.table,
  }));

  if (schema.excludedColumns?.[oldName]) {
    schema.excludedColumns = { ...schema.excludedColumns };
    schema.excludedColumns[newName] = schema.excludedColumns[oldName];
    delete schema.excludedColumns[oldName];
  }

  return {
    newSchema: schema,
    deterministicExplanation: `"${oldName}" renommée en "${newName}".`,
    changed: true,
  };
}

case 'rename_column': {
  const tableName = action.table;
  const oldColumn = action.oldColumn;
  const newColumn = (action.newColumn && typeof action.newColumn === 'string' && action.newColumn.trim())
    ? action.newColumn.trim()
    : null;

  if (!newColumn || typeof oldColumn !== 'string' || !oldColumn) {
    return { newSchema: schema, deterministicExplanation: `Colonnes mal spécifiées, aucun changement.`, changed: false };
  }

  const vd = (schema.virtualDimensions ?? []).find((v: any) => v.name.toLowerCase() === String(tableName).toLowerCase());
  if (!vd) {
    return {
      newSchema: schema,
      deterministicExplanation: `"${tableName}" introuvable parmi les dimensions virtuelles, aucun changement. (Le renommage de colonne n'est supporté que pour les dimensions créées via le chat.)`,
      changed: false,
    };
  }

  const colIndex = (vd.extraColumns ?? []).findIndex((c: any) => c.name.toLowerCase() === oldColumn.toLowerCase());
  if (colIndex === -1) {
    return { newSchema: schema, deterministicExplanation: `Colonne "${oldColumn}" introuvable dans "${vd.name}", aucun changement.`, changed: false };
  }

  const alreadyExists = (vd.extraColumns ?? []).some((c: any, i: number) => i !== colIndex && c.name.toLowerCase() === newColumn.toLowerCase());
  if (alreadyExists) {
    return { newSchema: schema, deterministicExplanation: `La colonne "${newColumn}" existe déjà dans "${vd.name}", aucun changement.`, changed: false };
  }

  const updatedExtraColumns = [...vd.extraColumns];
  updatedExtraColumns[colIndex] = { ...updatedExtraColumns[colIndex], name: newColumn };

  schema.virtualDimensions = (schema.virtualDimensions ?? []).map((v: any) =>
    v.name === vd.name ? { ...v, extraColumns: updatedExtraColumns } : v,
  );

  return {
    newSchema: schema,
    deterministicExplanation: `Colonne "${oldColumn}" renommée en "${newColumn}" dans "${vd.name}".`,
    changed: true,
  };
}
case 'change_column_type': {
  const tableName = action.table;
  const colName = action.column;
  const newType = (action.newType && typeof action.newType === 'string' && action.newType.trim())
    ? action.newType.trim()
    : null;

  if (!newType || typeof colName !== 'string' || !colName) {
    return { newSchema: schema, deterministicExplanation: `Colonne ou type mal spécifié, aucun changement.`, changed: false };
  }

  const vd = (schema.virtualDimensions ?? []).find((v: any) => v.name.toLowerCase() === String(tableName).toLowerCase());
  if (!vd) {
    return {
      newSchema: schema,
      deterministicExplanation: `"${tableName}" introuvable parmi les dimensions virtuelles, aucun changement. (Le changement de type n'est supporté que pour les dimensions créées via le chat.)`,
      changed: false,
    };
  }

  const colIndex = (vd.extraColumns ?? []).findIndex((c: any) => c.name.toLowerCase() === colName.toLowerCase());
  if (colIndex === -1) {
    return { newSchema: schema, deterministicExplanation: `Colonne "${colName}" introuvable dans "${vd.name}" (ou il s'agit de la clé primaire, non modifiable), aucun changement.`, changed: false };
  }

  const currentType = vd.extraColumns[colIndex].type;
  if (currentType.toUpperCase() === newType.toUpperCase()) {
    return { newSchema: schema, deterministicExplanation: `La colonne "${colName}" est déjà de type "${newType}", aucun changement.`, changed: false };
  }

  const updatedExtraColumns = [...vd.extraColumns];
  updatedExtraColumns[colIndex] = { ...updatedExtraColumns[colIndex], type: newType };

  schema.virtualDimensions = (schema.virtualDimensions ?? []).map((v: any) =>
    v.name === vd.name ? { ...v, extraColumns: updatedExtraColumns } : v,
  );

  return {
    newSchema: schema,
    deterministicExplanation: `Type de la colonne "${colName}" changé de "${currentType}" à "${newType}" dans "${vd.name}".`,
    changed: true,
  };
}
case 'rename_real_column': {
  const tableName = action.table;
  const oldColumn = action.oldColumn;
  const newColumn = (action.newColumn && typeof action.newColumn === 'string' && action.newColumn.trim())
    ? action.newColumn.trim()
    : null;
  const newType = (action.newType && typeof action.newType === 'string' && action.newType.trim())
    ? action.newType.trim()
    : null;

  if (!newColumn && !newType) {
    return { newSchema: schema, deterministicExplanation: `Ni nouveau nom ni nouveau type fourni, aucun changement.`, changed: false };
  }
  if (typeof oldColumn !== 'string' || !oldColumn) {
    return { newSchema: schema, deterministicExplanation: `Colonne d'origine mal spécifiée, aucun changement.`, changed: false };
  }

  const realDimExists = (schema.dimensions ?? []).some((d: string) => this.stripPrefix(d).toLowerCase() === this.stripPrefix(tableName).toLowerCase());
  const realFactExists = (schema.facts ?? []).some((f: string) => this.stripPrefix(f).toLowerCase() === this.stripPrefix(tableName).toLowerCase());
  if (!realDimExists && !realFactExists) {
    return { newSchema: schema, deterministicExplanation: `Table "${tableName}" introuvable, aucun changement.`, changed: false };
  }

  // ✅ CORRIGÉ (bug 1) : recherche la clé RÉELLE de tableAttributes en insensible à la casse,
  // au lieu de comparer strippedTableRaw (casse du LLM) directement à des clés qui gardent
  // la casse d'origine du staging (ex: "Products" vs "products").
  const strippedTableRaw = this.stripPrefix(tableName);
  const actualTableKey = Object.keys(schema.tableAttributes ?? {}).find(
    (k) => this.stripPrefix(k).toLowerCase() === strippedTableRaw.toLowerCase(),
  ) ?? strippedTableRaw;
  const strippedTable = actualTableKey;

  const existingAttrs = (schema.tableAttributes ?? {})[strippedTable] ?? [];
  const originalAttr = existingAttrs.find((a: any) => a.name.toLowerCase() === oldColumn.toLowerCase());
  if (!originalAttr) {
    return { newSchema: schema, deterministicExplanation: `Colonne "${oldColumn}" introuvable dans "${tableName}", aucun changement.`, changed: false };
  }

  const finalNewColumn = newColumn ?? originalAttr.name;
  const finalNewType = newType ?? originalAttr.type;

  // ✅ CORRIGÉ (bug 2, en profondeur) : si finalNewColumn ne diffère du nom d'origine que par
  // la casse, on ne le traite PAS comme un renommage réel dans le message — uniquement dans les
  // données internes (le stockage garde la nouvelle casse, mais l'explication reste honnête).
  const isActualRename = newColumn !== null && finalNewColumn.toLowerCase() !== originalAttr.name.toLowerCase();

  // Une seule transformation active par (table, colonne source) : on remplace si elle existe déjà
  schema.columnTransformations = (schema.columnTransformations ?? []).filter(
    (t: any) => !(this.stripPrefix(t.table).toLowerCase() === strippedTable.toLowerCase() && t.originalColumn.toLowerCase() === oldColumn.toLowerCase()),
  );
  schema.columnTransformations = [
    ...schema.columnTransformations,
    { table: strippedTable, originalColumn: oldColumn, newColumn: finalNewColumn, newColumnType: finalNewType },
  ];

  const parts: string[] = [];
  if (isActualRename) parts.push(`renommée en "${finalNewColumn}"`);
  if (newType) parts.push(`type changé en "${finalNewType}"`);
  if (parts.length === 0) parts.push('mise à jour (aucun changement visible détecté)');

  return {
    newSchema: schema,
    deterministicExplanation: `Colonne "${oldColumn}" de "${tableName}" ${parts.join(' et ')}.`,
    changed: true,
  };
}

case 'add_fact_column': {
  const factName = action.fact;
  const column = { name: action.columnName, type: action.columnType };

  if (typeof column.name !== 'string' || typeof column.type !== 'string' || !column.name || !column.type) {
    return { newSchema: schema, deterministicExplanation: `Colonne mal spécifiée, aucun changement.`, changed: false };
  }

  const vf = (schema.virtualFacts ?? []).find((v: any) => v.name.toLowerCase() === String(factName).toLowerCase());
  if (!vf) {
    return { newSchema: schema, deterministicExplanation: `Fait virtuel "${factName}" introuvable, aucun changement.`, changed: false };
  }

  const alreadyExists = (vf.measures ?? []).some((c: any) => c.name.toLowerCase() === column.name.toLowerCase())
    || vf.dimensionNames.some((d: string) => `${d}Id`.toLowerCase() === column.name.toLowerCase());
  if (alreadyExists) {
    return { newSchema: schema, deterministicExplanation: `La colonne "${column.name}" existe déjà dans "${vf.name}", aucun changement.`, changed: false };
  }

  vf.measures = [...(vf.measures ?? []), { name: column.name, type: column.type }];
  schema.virtualFacts = (schema.virtualFacts ?? []).map((v: any) => (v.name === vf.name ? vf : v));

  return {
    newSchema: schema,
    deterministicExplanation: `Colonne de mesure "${column.name}" (${column.type}) ajoutée au fait "${vf.name}".`,
    changed: true,
  };
}
case 'rename_fact_measure': {
  const factName = action.fact;
  const oldColumn = action.oldColumn;
  const newColumn = (action.newColumn && typeof action.newColumn === 'string' && action.newColumn.trim())
    ? action.newColumn.trim()
    : null;
  const newType = (action.newType && typeof action.newType === 'string' && action.newType.trim())
    ? action.newType.trim()
    : null;

  if (!newColumn && !newType) {
    return { newSchema: schema, deterministicExplanation: `Ni nouveau nom ni nouveau type fourni, aucun changement.`, changed: false };
  }
  if (typeof oldColumn !== 'string' || !oldColumn) {
    return { newSchema: schema, deterministicExplanation: `Colonne d'origine mal spécifiée, aucun changement.`, changed: false };
  }

  const vf = (schema.virtualFacts ?? []).find((v: any) => v.name.toLowerCase() === String(factName).toLowerCase());
  if (!vf) {
    return { newSchema: schema, deterministicExplanation: `Fait virtuel "${factName}" introuvable, aucun changement.`, changed: false };
  }

  const measureIndex = (vf.measures ?? []).findIndex((m: any) => m.name.toLowerCase() === oldColumn.toLowerCase());
  if (measureIndex === -1) {
    return { newSchema: schema, deterministicExplanation: `Mesure "${oldColumn}" introuvable dans "${vf.name}", aucun changement.`, changed: false };
  }

  const finalNewName = newColumn ?? vf.measures[measureIndex].name;
  const finalNewType = newType ?? vf.measures[measureIndex].type;

  const updatedMeasures = [...vf.measures];
  updatedMeasures[measureIndex] = { name: finalNewName, type: finalNewType };

  schema.virtualFacts = (schema.virtualFacts ?? []).map((v: any) =>
    v.name === vf.name ? { ...v, measures: updatedMeasures } : v,
  );

  const parts: string[] = [];
  if (newColumn) parts.push(`renommée en "${finalNewName}"`);
  if (newType) parts.push(`type changé en "${finalNewType}"`);

  return {
    newSchema: schema,
    deterministicExplanation: `Mesure "${oldColumn}" de "${vf.name}" ${parts.join(' et ')}.`,
    changed: true,
  };
}


    default:
      return { newSchema: schema, deterministicExplanation: '', changed: false };
  }
}

// private buildChatPrompt(currentSchema: any, userMessage: string): string {
//   const dims = (currentSchema.dimensions ?? []).join(', ');
//   const facts = (currentSchema.facts ?? []).join(', ');
//   const relations = (currentSchema.confirmedRelations ?? [])
//     .map((r: any) => `${r.tableA}.${r.columnA}-${r.tableB}.${r.columnB}`)
//     .join('; ');
//   const subDims = (currentSchema.subDimensions ?? [])
//     .map((sd: any) => `${sd.name}(from ${sd.parentDimension}.${sd.sourceColumn})`)
//     .join('; ');

//   return `You manage a data warehouse schema. Current state:
// Dimensions: ${dims || 'none'}
// Facts: ${facts || 'none'}
// Relations: ${relations || 'none'}
// Sub-dimensions: ${subDims || 'none'}

// User request: "${userMessage}"

// Pick EXACTLY ONE action that matches the request. Do NOT modify anything not explicitly asked.

// Available actions:
// - {"action":"none","reply":"..."} — if it's just a question, no change needed
// - {"action":"move_to_fact","table":"TableName","reply":"..."}
// - {"action":"move_to_dimension","table":"TableName","reply":"..."}
// - {"action":"remove_dimension","table":"TableName","reply":"..."} — completely remove a dimension from the DW (it goes back to unclassified staging)
// - {"action":"remove_fact","table":"TableName","reply":"..."} — completely remove a fact table from the DW
// - {"action":"add_relation","tableA":"X","columnA":"colX","tableB":"Y","columnB":"colY","reply":"..."}
// - {"action":"remove_relation","tableA":"X","columnA":"colX","tableB":"Y","columnB":"colY","reply":"..."}
// - {"action":"remove_subdimension","name":"DimX","reply":"..."}
// - {"action":"unsupported","reply":"explain why this request cannot be applied"}

// Rules:
// - "table" must be an EXACT name from the lists above.
// - Never touch "DimTemps" or its relations — reply "unsupported" if asked.
// - "reply" is a short, natural sentence in French explaining what you are doing (or why not).

// ⚠️ Reply ONLY with valid JSON for ONE action, nothing else.`;
// }
private buildChatPrompt(currentSchema: any, userMessage: string, recentExchanges: { user: string; ai: string }[] = []): string {
  const historyBlock = this.formatRecentHistory(recentExchanges);
  const dims = (currentSchema.dimensions ?? []).join(', ');
  const facts = (currentSchema.facts ?? []).join(', ');
  const relations = (currentSchema.confirmedRelations ?? [])
    .map((r: any) => `${r.tableA}.${r.columnA}-${r.tableB}.${r.columnB}`)
    .join('; ');
  const subDims = (currentSchema.subDimensions ?? [])
    .map((sd: any) => `${sd.name}(from ${sd.parentDimension}.${sd.sourceColumn})`)
    .join('; ');

  const virtualDimColumns = (currentSchema.virtualDimensions ?? [])
    .map((vd: any) => {
      const cols = [`${vd.name}Id (clé primaire, ne jamais renommer/supprimer/changer le type)`, ...(vd.extraColumns ?? []).map((c: any) => `${c.name} (${c.type})`)];
      return `${vd.name}: ${cols.join(', ')}`;
    })
    .join(' | ');

  const virtualFactColumns = (currentSchema.virtualFacts ?? [])
    .map((vf: any) => {
      const cols = [
        `${vf.name}Id (clé primaire, ne jamais modifier)`,
        ...(vf.dimensionNames ?? []).map((d: string) => `${d}Id (clé étrangère vers ${d}, ne jamais modifier)`),
        ...(vf.measures ?? []).map((m: any) => `${m.name} (${m.type})`),
      ];
      return `${vf.name}: ${cols.join(', ')}`;
    })
    .join(' | ');

  const virtualNames = new Set([
    ...(currentSchema.virtualDimensions ?? []).map((vd: any) => vd.name),
    ...(currentSchema.virtualFacts ?? []).map((vf: any) => vf.name),
  ]);
  const realTableColumns = Object.entries(currentSchema.tableAttributes ?? {})
    .filter(([tableName]) => !virtualNames.has(tableName) && !tableName.toLowerCase().includes('dimtemps'))
    .map(([tableName, cols]: [string, any]) => `${tableName}: ${(cols as any[]).map((c) => `${c.name} (${c.type})`).join(', ')}`)
    .join(' | ');

  return `You manage a data warehouse schema. Current state:
Dimensions: ${dims || 'none'}
Facts: ${facts || 'none'}
Relations: ${relations || 'none'}
Sub-dimensions: ${subDims || 'none'}
Virtual dimension columns (EXACT names, use these ONLY): ${virtualDimColumns || 'none'}
Virtual fact columns (EXACT names, use these ONLY for add_fact_column): ${virtualFactColumns || 'none'}
Real table columns from staging (EXACT names, use these ONLY): ${realTableColumns || 'none'}
${historyBlock}
User message: "${userMessage}"

⚠️ STEP 1 — Decide FIRST: is this a QUESTION/GENERAL REQUEST (asking for information, explanation, definition, comparison, opinion) or a MODIFICATION REQUEST (explicitly asking to change/add/remove something in THIS schema)?

If it is a QUESTION or you are not 100% sure it is a modification request targeting an EXISTING element listed above: use {"action":"answer_question","reply":"your answer in French"}.

⚠️ NEVER use "remove_subdimension", "remove_dimension" or "remove_fact" unless the user explicitly names a table/sub-dimension that appears in the lists above, AND clearly asks to remove/delete it.

⚠️ CRITICAL: "crée/créer une [nouvelle] table de fait [nommée X]" is ALWAYS "create_fact_table", NEVER "add_fact_column" — even if the message also mentions a measure name. Example: "crée un fait Ventes relié à Products et Resellers avec une mesure Montant en décimal" -> {"action":"create_fact_table","name":"Ventes","dimensions":["Products","Resellers"],"measures":[{"name":"Montant","type":"DECIMAL(18,4)"}],"reply":"..."}. Use "add_fact_column" ONLY when the user refers to a fact table that ALREADY appears in "Facts" above, without asking to create a new one.

⚠️ CRITICAL: "ajoute une colonne X à Y" means a BRAND NEW column with no prior data.
- If Y appears in "Real table columns" -> use "add_real_column" (NEVER "rename_real_column", which is ONLY for renaming/retyping a column that ALREADY exists).
- If Y appears in "Virtual dimension columns" -> use "add_dimension_column".
- If Y appears in "Virtual fact columns" -> use "add_fact_column".

Examples of what "answer_question" is for (do NOT touch the schema for these):
- "what is a star schema?" -> answer_question
- "explain the difference between X and Y" -> answer_question
- "what do you think about..." -> answer_question
- "can you turn this into a star schema?" -> answer_question, explain in "reply" that this specific transformation is not supported yet, suggest removing sub-dimensions one by one instead

Available actions for ACTUAL modifications:
- {"action":"answer_question","reply":"..."}
- {"action":"move_to_fact","table":"TableName","reply":"..."}
- {"action":"move_to_dimension","table":"TableName","reply":"..."}
- {"action":"remove_dimension","table":"TableName","reply":"..."}
- {"action":"remove_fact","table":"TableName","reply":"..."}
- {"action":"add_relation","tableA":"X","columnA":"colX","tableB":"Y","columnB":"colY","reply":"..."}
- {"action":"remove_relation","tableA":"X","columnA":"colX","tableB":"Y","columnB":"colY","reply":"..."}
- {"action":"remove_subdimension","name":"DimX","reply":"..."}
- {"action":"create_fact_table","name":"FactName","dimensions":["Dim1","Dim2"],"measures":[{"name":"measureName","type":"INT|DECIMAL(18,4)"}],"reply":"..."} — create a NEW empty fact table with foreign keys to the listed dimensions (at least 2, EXACT names from the list above). "measures" is OPTIONAL: only include numeric measure columns explicitly requested by the user (e.g. "montant"/"prix"/"chiffre d'affaires" -> DECIMAL(18,4), "quantité"/"nombre" -> INT).
- {"action":"add_fact_column","fact":"FactName","columnName":"colName","columnType":"INT|DECIMAL(18,4)","reply":"..."} — add a new numeric measure column to an EXISTING virtual fact table. "fact" must be an EXACT name from "Virtual fact columns" above.
- {"action":"create_dimension","name":"DimName","linkedFact":"FactName","columns":[{"name":"colName","type":"INT|VARCHAR(255)|DATE|DECIMAL(18,4)"}],"reply":"..."} — create a NEW empty dimension table linked to an EXISTING fact table. "columns" is OPTIONAL: only include extra columns explicitly requested by the user (besides the automatic primary key). Map data types mentioned in French to SQL types (e.g. "salaire"/"montant" -> DECIMAL(18,4), "nombre"/"entier" -> INT, "texte"/"nom" -> VARCHAR(255), "date" -> DATE).
- {"action":"remove_dimension_column","dimension":"DimName","column":"colName","reply":"..."} — remove an extra column from a VIRTUAL dimension only (never removes the automatic primary key)
- {"action":"add_dimension_column","dimension":"DimName","columnName":"colName","columnType":"INT|VARCHAR(255)|DATE|DECIMAL(18,4)","reply":"..."} — add a new column to an EXISTING virtual dimension.
- {"action":"add_real_column","table":"TableName","columnName":"colName","columnType":"INT|VARCHAR(255)|DATE|DECIMAL(18,4)","reply":"..."} — add a brand NEW column (no existing source) to a table from "Real table columns" list.
- {"action":"rename_table","oldName":"OldName","newName":"NewName","reply":"..."} — rename an EXISTING dimension or fact table (virtual or real).
- {"action":"rename_column","table":"DimName","oldColumn":"oldColName","newColumn":"newColName","reply":"..."} — rename a column ONLY in a VIRTUAL dimension (from "Virtual dimension columns" list).
- {"action":"change_column_type","table":"DimName","column":"colName","newType":"INT|VARCHAR(255)|DATE|DECIMAL(18,4)","reply":"..."} — change the type of a column ONLY in a VIRTUAL dimension (from "Virtual dimension columns" list).
- {"action":"rename_real_column","table":"TableName","oldColumn":"oldColName","newColumn":"newColName","newType":"INT|VARCHAR(255)|DATE|DECIMAL(18,4)","reply":"..."} — rename AND/OR retype a column that ALREADY EXISTS in a REAL staging table (from "Real table columns" list). "table" and "oldColumn" MUST match that list exactly. "newColumn" and "newType" are each OPTIONAL (provide at least one): omit "newColumn" to keep the name and only change the type, omit "newType" to keep the type and only rename.

⚠️ CRITICAL ROUTING RULE:
- If the target table appears in "Virtual dimension columns" -> use "rename_column" or "change_column_type".
- If the target table appears in "Real table columns" -> use "rename_real_column" for an EXISTING column, or "add_real_column" for a BRAND NEW column.
- Never use "rename_column"/"change_column_type" for a table listed only in "Real table columns".

Rules:
- "table"/"name" must be an EXACT name from the lists above. If it does not match exactly, use "answer_question" instead and explain the name was not found.
- "oldColumn"/"column" MUST be an EXACT name from the matching columns list above (Virtual dimension columns OR Real table columns, depending on the action). If you cannot find it there, use "answer_question" instead and list the real column names that exist.
- Never touch "DimTemps" or its relations.
- "reply" is a short, natural sentence in French.

⚠️ Reply ONLY with valid JSON for ONE action, nothing else.`;
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

  // ✅ NOUVEAU : détecter les changements de sous-dimensions
  const oldSubDims = oldSchema.subDimensions ?? [];
  const newSubDims = newSchema.subDimensions ?? [];

  const oldSubDimNames = new Set(oldSubDims.map((sd: any) => sd.name));
  const newSubDimNames = new Set(newSubDims.map((sd: any) => sd.name));

  const addedSubDims = newSubDims.filter((sd: any) => !oldSubDimNames.has(sd.name));
  const removedSubDims = oldSubDims.filter((sd: any) => !newSubDimNames.has(sd.name));

  addedSubDims.forEach((sd: any) => changes.push(`${sd.name} ajoutée comme sous-dimension`));
  removedSubDims.forEach((sd: any) => changes.push(`${sd.name} retirée des sous-dimensions`));

  return changes.length > 0 ? changes.join(' ; ') : 'Aucun changement détecté dans le schéma';
}


// async applyChatModification(
//   database: string,
//   currentSchema: any,
//   userMessage: string,
// ): Promise<{ updatedSchema: AiSchemaProposal; explanation: string; schemaChanged: boolean }> {
//   const metadata = await this.getMetadataWithCache(database);
//   const validTableNames = new Set(metadata.map((cols) => cols[0]?.sourceTable).filter(Boolean));
//   const validColumnsByTable = new Map<string, Set<string>>();
//   for (const cols of metadata) {
//     if (cols.length === 0) continue;
//     validColumnsByTable.set(cols[0].sourceTable, new Set(cols.map((c) => c.columnName)));
//   }

//   const internalCurrentSchema = this.restoreInternalNames(currentSchema, validTableNames);

//   const prompt = this.buildChatPrompt(internalCurrentSchema, userMessage);

//   // Nombre max de tables réelles pouvant disparaître en un seul message avant
//   // de considérer que c'est un oubli du modèle plutôt qu'un retrait volontaire.
//   const MAX_INTENTIONAL_TABLE_DROP = 2;

//   let lastError: string | null = null;
//   for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
//     try {
//       const rawResponse = await this.callOllama(prompt);
//       const cleaned = rawResponse.replace(/```json|```/g, '').trim();
//       const parsed = JSON.parse(cleaned);

//       const previousDimensions: string[] = internalCurrentSchema.dimensions ?? [];
//       const previousFacts: string[] = internalCurrentSchema.facts ?? [];
//       const previousRealTables = new Set(
//         [...previousDimensions, ...previousFacts]
//           .map((t) => this.stripPrefix(t))
//           .filter((t) => validTableNames.has(t) || validTableNames.has(`staging_${t}`)),
//       );

//       const proposedDimensions: string[] = Array.isArray(parsed.dimensions) ? parsed.dimensions : [];
//       const proposedFacts: string[] = Array.isArray(parsed.facts) ? parsed.facts : [];
//       const proposedRealTables = new Set(
//         [...proposedDimensions, ...proposedFacts]
//           .map((t) => this.stripPrefix(t))
//           .filter((t) => validTableNames.has(t) || validTableNames.has(`staging_${t}`)),
//       );

//       const droppedTables = [...previousRealTables].filter((t) => !proposedRealTables.has(t));
//       const dropLooksIntentional =
//         droppedTables.length > 0 && droppedTables.length <= MAX_INTENTIONAL_TABLE_DROP;
//       const dropLooksLikeModelError = droppedTables.length > MAX_INTENTIONAL_TABLE_DROP;

//       if (dropLooksLikeModelError) {
//         console.warn(
//           `[applyChatModification] ${droppedTables.length} table(s) auraient disparu (${droppedTables.join(', ')}) — probable oubli du modèle, classification conservée telle quelle.`,
//         );
//       }

//       const sourceForValidation = parsed.schemaChanged === false
//         ? internalCurrentSchema
//         : {
//             // ✅ On ne fait confiance à la nouvelle classification que si :
//             //    - le tableau n'est pas vide, ET
//             //    - la perte de tables reste dans une plage plausible pour une action volontaire
//             dimensions:
//               proposedDimensions.length > 0 && !dropLooksLikeModelError
//                 ? proposedDimensions
//                 : previousDimensions,
//             facts:
//               proposedFacts.length > 0 && !dropLooksLikeModelError
//                 ? proposedFacts
//                 : previousFacts,
//             confirmedRelations: Array.isArray(parsed.confirmedRelations) && parsed.confirmedRelations.length > 0
//               ? parsed.confirmedRelations
//               : internalCurrentSchema.confirmedRelations,
//             // subDimensions PEUT légitimement devenir [] (ex: "retire toutes les sous-dimensions"),
//             // donc on ne retombe sur l'ancien tableau QUE si le champ est absent (undefined/null).
//             subDimensions: parsed.subDimensions ?? internalCurrentSchema.subDimensions,
//           };

//       const validated = this.validateAndClean(
//         {
//           dimensions: sourceForValidation.dimensions,
//           facts: sourceForValidation.facts,
//           confirmedRelations: sourceForValidation.confirmedRelations,
//           additionalRelations: [],
//           subDimensions: sourceForValidation.subDimensions ?? [],
//         } as any,
//         validTableNames,
//         validColumnsByTable,
//         metadata,
//         false, // mode chat : ne force pas la ré-ajout d'une table volontairement retirée
//       );

//       const displayed = this.applyDisplayNames(validated);

//       if (parsed.schemaChanged === false) {
//         return {
//           updatedSchema: { ...displayed, rawResponse },
//           explanation: parsed.reply ?? "Je n'ai pas de réponse claire à ta demande, peux-tu reformuler ?",
//           schemaChanged: false,
//         };
//       }

//       const diffText = this.computeDiffExplanation(internalCurrentSchema, validated);
//       const hasRealChange = diffText !== 'Aucun changement détecté dans le schéma';

//       const modelErrorNote = dropLooksLikeModelError
//         ? `\n\n(Note : ${droppedTables.length} table(s) semblaient disparaître de la classification de façon inattendue — classification d'origine conservée par sécurité, seules les relations/sous-dimensions demandées ont été appliquées.)`
//         : '';

//       const finalReply =
//         (hasRealChange
//           ? `${parsed.reply ?? ''}\n\n(Changement appliqué : ${diffText})`
//           : parsed.reply ?? "Je n'ai pas de réponse claire à ta demande, peux-tu reformuler ?") + modelErrorNote;

//       return {
//         updatedSchema: { ...displayed, rawResponse },
//         explanation: finalReply,
//         schemaChanged: hasRealChange,
//       };
//     } catch (err) {
//       lastError = err.message;
//       console.warn(`Chat - tentative ${attempt}/${this.MAX_RETRIES} échouée: ${lastError}`);
//     }
//   }

//   throw new InternalServerErrorException(
//     `L'IA n'a pas réussi à traiter ta demande après ${this.MAX_RETRIES} tentatives. Dernière erreur: ${lastError}`,
//   );
// }

private isQuestionAboutCurrentSchema(userMessage: string, schema: any): boolean {
  const allTableNames = [
    ...(schema.dimensions ?? []),
    ...(schema.facts ?? []),
    ...(schema.subDimensions ?? []).map((sd: any) => sd.name),
  ].map((t: string) => t.toLowerCase());

  const lowerMessage = userMessage.toLowerCase();

  // Correspondance directe : un nom de table réel est cité
  if (allTableNames.some((name) => lowerMessage.includes(name))) return true;

  // Référence explicite au schéma/diagramme actuel, même sans citer de nom de table précis
  const contextReferenceKeywords = [
    'ce schema', 'ce schéma', 'ce diagramme', 'cette base', 'ces tables', 'ces donnees', 'ces données',
    'dans le schema', 'dans le schéma', 'du schema', 'du schéma', 'de ce dw', 'ce dw', 'ce data warehouse',
  ];
  if (contextReferenceKeywords.some((kw) => lowerMessage.includes(kw))) return true;

  return false;
}


private formatRecentHistory(recentExchanges: { user: string; ai: string }[]): string {
  if (recentExchanges.length === 0) return '';
  const lines = recentExchanges.map((ex) => `User: ${ex.user}\nAssistant: ${ex.ai}`).join('\n');
  return `\nRecent conversation (for context, e.g. to understand "also", "why not", follow-ups):\n${lines}\n`;
}

/**
 * Détecte de façon déterministe (regex, pas de LLM) une intention de création de fait
 * dans le message utilisateur, et en extrait le nom, les dimensions citées et les mesures.
 * Retourne null si le message ne ressemble pas à une demande de création de fait.
 */
private extractFactCreationHint(
  userMessage: string,
  schema: any,
): { name: string | null; dimensions: string[]; measures: { name: string; type: string }[] } | null {
  const CREATION_PATTERN = /(?:cr[ée]e?r?|ajoute)\s+(?:une\s+)?(?:nouvelle\s+)?(?:table\s+de\s+)?fait/i;
  if (!CREATION_PATTERN.test(userMessage)) return null;

  // --- Nom du fait : "nommée X", "appelé X", "named X" ---
  const nameMatch = userMessage.match(/(?:nomm[ée]e?|appel[ée]e?|named)\s+["']?([A-Za-zÀ-ÿ0-9_]+)["']?/i);
  const name = nameMatch ? nameMatch[1] : null;

  // --- Dimensions : cherche chaque nom de dimension existante comme sous-chaîne du message ---
  const schemaDimensionsStripped: string[] = (schema.dimensions ?? []).map((d: string) => this.stripPrefix(d));
  const normalize = (s: string) => s.toLowerCase().replace(/[_\s-]/g, '');
  const normalizedMessage = normalize(userMessage);
  const dimensions = schemaDimensionsStripped.filter((d) => normalizedMessage.includes(normalize(d)));

  // --- Mesures : "mesure X en TYPE" (accepte decimal/décimal/entier/int/texte/date) ---
  const typeMap: Record<string, string> = {
    decimal: 'DECIMAL(18,4)',
    décimal: 'DECIMAL(18,4)',
    montant: 'DECIMAL(18,4)',
    entier: 'INT',
    int: 'INT',
    nombre: 'INT',
    texte: 'VARCHAR(255)',
    date: 'DATE',
  };
  const measures: { name: string; type: string }[] = [];
  const measureRegex = /mesure\s+([A-Za-zÀ-ÿ0-9_]+)\s+en\s+([A-Za-zÀ-ÿ]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = measureRegex.exec(userMessage)) !== null) {
    const measureName = m[1];
    const rawType = m[2].toLowerCase();
    const sqlType = typeMap[rawType] ?? 'DECIMAL(18,4)';
    measures.push({ name: measureName, type: sqlType });
  }

  return { name, dimensions, measures };
}
/**
 * Détecte de façon déterministe (regex, pas de LLM) une intention d'ajout de mesure
 * à un fait EXISTANT. Retourne null si le message ne correspond pas à ce pattern.
 */
private extractAddFactColumnHint(
  userMessage: string,
  schema: any,
): { fact: string; columnName: string; columnType: string } | null {
  const ADD_MEASURE_PATTERN = /ajoute\s+(?:la\s+)?mesure/i;
  if (!ADD_MEASURE_PATTERN.test(userMessage)) return null;

  const virtualFacts: any[] = schema.virtualFacts ?? [];
  if (virtualFacts.length === 0) return null;

  const normalize = (s: string) =>
    s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[_\s-]/g, '');
  const normalizedMessage = normalize(userMessage);

  // Trouve quel fait EXISTANT est cité dans le message
  const matchedFact = virtualFacts.find((vf) => normalizedMessage.includes(normalize(vf.name)));
  if (!matchedFact) return null;

  // Nom de la mesure : "mesure X" ou "mesure nommée X" ou "mesure appelée X"
  const nameMatch = userMessage.match(/mesure\s+(?:nomm[ée]e?\s+|appel[ée]e?\s+)?["']?([A-Za-zÀ-ÿ0-9_]+)["']?/i);
  if (!nameMatch) return null;
  const columnName = nameMatch[1];

  // Type : "de type X" ou "en X"
  const typeMap: Record<string, string> = {
    decimal: 'DECIMAL(18,4)',
    décimal: 'DECIMAL(18,4)',
    montant: 'DECIMAL(18,4)',
    entier: 'INT',
    int: 'INT',
    nombre: 'INT',
    texte: 'VARCHAR(255)',
    date: 'DATE',
  };
  const typeMatch = userMessage.match(/(?:de\s+type|en)\s+([A-Za-zÀ-ÿ]+)/i);
  const rawType = typeMatch ? typeMatch[1].toLowerCase() : null;
  const columnType = (rawType && typeMap[rawType]) ?? 'DECIMAL(18,4)';

  return { fact: matchedFact.name, columnName, columnType };
}

async applyChatModification(
  database: string,
  currentSchema: any,
  userMessage: string,
  recentExchanges: { user: string; ai: string }[] = [],
): Promise<{ updatedSchema: AiSchemaProposal; explanation: string; schemaChanged: boolean }> {
  const metadata = await this.getMetadataWithCache(database);
  const validTableNames = new Set(metadata.map((cols) => cols[0]?.sourceTable).filter(Boolean));
  const validColumnsByTable = new Map<string, Set<string>>();
  for (const cols of metadata) {
    if (cols.length === 0) continue;
    validColumnsByTable.set(cols[0].sourceTable, new Set(cols.map((c) => c.columnName)));
  }

  const internalCurrentSchema = this.restoreInternalNames(currentSchema, validTableNames);

  if (!this.isQuestionAboutCurrentSchema(userMessage, internalCurrentSchema)) {
    const historyBlock = this.formatRecentHistory(recentExchanges);
    const genericPrompt = `Tu es un expert en Business Intelligence et modélisation de data warehouse.
${historyBlock}
Question de l'utilisateur : "${userMessage}"

Réponds de façon concise et factuelle en français, en te basant uniquement sur ta connaissance générale de la BI (pas de référence à un schéma particulier).

Réponds STRICTEMENT en JSON : {"reply":"ta réponse ici"}`;

    try {
      const rawResponse = await this.callOllama(genericPrompt);
      const cleaned = rawResponse.replace(/```json|```/g, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
      return {
        updatedSchema: currentSchema,
        explanation: parsed.reply ?? "Je n'ai pas de réponse claire, peux-tu reformuler ?",
        schemaChanged: false,
      };
    } catch (err) {
      console.warn(`[applyChatModification] Échec question générique: ${err.message}`);
      return {
        updatedSchema: currentSchema,
        explanation: "Je n'ai pas pu traiter cette question, peux-tu reformuler ?",
        schemaChanged: false,
      };
    }
  }

  const ACTION_VERBS = ['retir', 'supprim', 'enlev', 'ajout', 'ajoute', 'deplac', 'déplac', 'transform', 'cree', 'crée', 'change', 'modifi', 'renomm'];
  const messageHasActionVerb = ACTION_VERBS.some((v) => userMessage.toLowerCase().includes(v));

  if (!messageHasActionVerb) {
    const historyBlock = this.formatRecentHistory(recentExchanges);
    const clarificationPrompt = `Tu es un assistant qui aide à comprendre un schéma de data warehouse.

Schéma actuel :
Dimensions: ${(internalCurrentSchema.dimensions ?? []).join(', ')}
Facts: ${(internalCurrentSchema.facts ?? []).join(', ')}
Relations: ${(internalCurrentSchema.confirmedRelations ?? []).map((r: any) => `${r.tableA}.${r.columnA}-${r.tableB}.${r.columnB}`).join('; ')}
${historyBlock}
Message de l'utilisateur : "${userMessage}"

Réponds à sa question/remarque en français, en te basant sur le schéma et la conversation ci-dessus. Ne propose aucune modification, réponds juste de façon informative.

Réponds STRICTEMENT en JSON : {"reply":"ta réponse ici"}`;

    try {
      const rawResponse = await this.callOllama(clarificationPrompt);
      const cleaned = rawResponse.replace(/```json|```/g, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
      return {
        updatedSchema: currentSchema,
        explanation: parsed.reply ?? "Je n'ai pas de réponse claire, peux-tu reformuler ?",
        schemaChanged: false,
      };
    } catch (err) {
      console.warn(`[applyChatModification] Échec clarification: ${err.message}`);
      return {
        updatedSchema: currentSchema,
        explanation: "Je n'ai pas compris, peux-tu reformuler ?",
        schemaChanged: false,
      };
    }
  }

  const factCreationHint = this.extractFactCreationHint(userMessage, internalCurrentSchema);
  const addFactColumnHint = this.extractAddFactColumnHint(userMessage, internalCurrentSchema);

  const prompt = this.buildChatPrompt(internalCurrentSchema, userMessage, recentExchanges);

  const normalizeForMatch = (s: string) =>
    s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[_\s-]/g, '');

  const TABLE_FIELD_BY_ACTION: Record<string, string> = {
    move_to_fact: 'table',
    move_to_dimension: 'table',
    remove_dimension: 'table',
    remove_fact: 'table',
    remove_dimension_column: 'dimension',
    add_dimension_column: 'dimension',
    add_fact_column: 'fact',
    add_real_column: 'table',
    rename_table: 'oldName',
    rename_column: 'table',
    change_column_type: 'table',
    rename_real_column: 'table',
    rename_fact_measure: 'fact',
    create_dimension: 'linkedFact',
  };

  const COLUMN_FIELD_BY_ACTION: Record<string, string> = {
    remove_dimension_column: 'column',
    rename_column: 'oldColumn',
    change_column_type: 'column',
    rename_real_column: 'oldColumn',
    rename_fact_measure: 'oldColumn',
  };

  let lastError: string | null = null;
  for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
    try {
      const rawResponse = await this.callOllama(prompt);
      console.log('[DEBUG action brute]', rawResponse);

      let cleaned = rawResponse.replace(/```json|```/g, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      cleaned = jsonMatch ? jsonMatch[0] : cleaned;

      let action: any;
      try {
        action = JSON.parse(cleaned);
      } catch (parseErr) {
        const repaired = cleaned
          .replace(/"\s*\n?\s*"/g, '", "')
          .replace(/,\s*([}\]])/g, '$1')
          .replace(/}\s*{/g, '}, {');

        try {
          action = JSON.parse(repaired);
        } catch (secondErr) {
          console.warn(`[applyChatModification] JSON action illisible même après réparation: ${cleaned.substring(0, 300)}`);
          throw parseErr;
        }
      }

      if (factCreationHint) {
        const llmGaveCreateAction = action.action === 'create_fact_table';

        const mergedName = factCreationHint.name
          ?? (llmGaveCreateAction && action.name ? action.name : null);

        const llmDimensions: string[] = llmGaveCreateAction && Array.isArray(action.dimensions)
          ? action.dimensions.map((d: string) => this.stripPrefix(d))
          : [];
        const mergedDimensions = factCreationHint.dimensions.length > 0
          ? factCreationHint.dimensions
          : llmDimensions;

        const llmMeasures = llmGaveCreateAction && Array.isArray(action.measures) ? action.measures : [];
        const mergedMeasures = factCreationHint.measures.length > 0
          ? factCreationHint.measures
          : llmMeasures;

        if (!llmGaveCreateAction) {
          console.warn(`[applyChatModification] Intention de création de fait détectée par regex mais LLM a choisi "${action.action}" — forcé vers create_fact_table.`);
        }

        action = {
          action: 'create_fact_table',
          name: mergedName,
          dimensions: mergedDimensions,
          measures: mergedMeasures,
          reply: action.reply ?? '',
        };
      }
      else if (addFactColumnHint) {
        console.warn(`[applyChatModification] Ajout de mesure détecté par regex, action forcée : ${JSON.stringify(addFactColumnHint)}`);
        action = {
          action: 'add_fact_column',
          fact: addFactColumnHint.fact,
          columnName: addFactColumnHint.columnName,
          columnType: addFactColumnHint.columnType,
          reply: action.reply ?? '',
        };
      }

      // Auto-correction de la table cible AVANT toute redirection/validation.
      const tableField = TABLE_FIELD_BY_ACTION[action.action];
      if (tableField && typeof action[tableField] === 'string' && action[tableField].trim()) {
        const strippedCurrent = this.stripPrefix(action[tableField]);
        const currentMatchesMessage = normalizeForMatch(userMessage).includes(normalizeForMatch(strippedCurrent));

        if (!currentMatchesMessage) {
          const resolved = this.resolveTableFromMessage(userMessage, internalCurrentSchema);
          if (resolved) {
            console.warn(`[applyChatModification] Table "${action[tableField]}" absente du message — corrigée automatiquement en "${resolved}".`);
            action[tableField] = resolved;
          }
        }
      }

      if (action.action === 'add_dimension_column') {
        const targetName = action.dimension;
        const existsAsReal = internalCurrentSchema.dimensions?.some((d: string) => this.stripPrefix(d) === this.stripPrefix(targetName));
        const existsAsVirtual = internalCurrentSchema.virtualDimensions?.some((vd: any) => vd.name === targetName);

        if (existsAsReal && !existsAsVirtual) {
          console.warn(`[applyChatModification] "${targetName}" est une table réelle — reclassé de add_dimension_column vers add_real_column.`);
          action = {
            action: 'add_real_column',
            table: this.stripPrefix(targetName),
            columnName: action.columnName,
            columnType: action.columnType,
            reply: action.reply,
          };
        } else if (!existsAsReal && !existsAsVirtual && (internalCurrentSchema.facts ?? []).length >= 1) {
          console.warn(`[applyChatModification] "${targetName}" inconnue — reclassé de add_dimension_column vers create_dimension.`);
          action = {
            action: 'create_dimension',
            name: targetName,
            linkedFact: this.stripPrefix(internalCurrentSchema.facts[0]),
            columns: [{ name: action.columnName, type: action.columnType }],
            reply: action.reply,
          };
        }
      }

      if (action.action === 'add_fact_column') {
        const targetFactName = action.fact;
        const existsAsVirtualFact = internalCurrentSchema.virtualFacts?.some(
          (vf: any) => vf.name.toLowerCase() === String(targetFactName).toLowerCase(),
        );
        const existsAsReal = internalCurrentSchema.facts?.some((f: string) => this.stripPrefix(f).toLowerCase() === this.stripPrefix(targetFactName).toLowerCase());

        if (existsAsReal && !existsAsVirtualFact) {
          console.warn(`[applyChatModification] "${targetFactName}" est un fait réel — reclassé de add_fact_column vers add_real_column.`);
          action = {
            action: 'add_real_column',
            table: this.stripPrefix(targetFactName),
            columnName: action.columnName,
            columnType: action.columnType,
            reply: action.reply,
          };
        } else if (!existsAsVirtualFact) {
          console.warn(`[applyChatModification] Fait "${targetFactName}" introuvable pour add_fact_column, action ignorée.`);
          return {
            updatedSchema: currentSchema,
            explanation: `Impossible d'ajouter la colonne : le fait "${targetFactName}" n'existe pas. Précise le nom exact ou demande d'abord sa création.`,
            schemaChanged: false,
          };
        }
      }

      if (action.action === 'rename_column' || action.action === 'change_column_type') {
        const targetTable = action.table;
        const strippedTarget = this.stripPrefix(targetTable).toLowerCase();

        const isVirtualDim = internalCurrentSchema.virtualDimensions?.some(
          (vd: any) => vd.name.toLowerCase() === strippedTarget,
        );
        const isVirtualFact = internalCurrentSchema.virtualFacts?.some(
          (vf: any) => vf.name.toLowerCase() === strippedTarget,
        );

        const carriedNewColumn = action.action === 'rename_column' ? action.newColumn : undefined;
        const carriedNewType = action.action === 'change_column_type' ? action.newType : undefined;

        if (isVirtualFact) {
          console.warn(`[applyChatModification] "${action.action}" redirigé vers "rename_fact_measure" : "${targetTable}" est un fait virtuel.`);
          action = {
            action: 'rename_fact_measure',
            fact: this.stripPrefix(targetTable),
            oldColumn: action.oldColumn ?? action.column,
            newColumn: carriedNewColumn,
            newType: carriedNewType,
            reply: action.reply,
          };
        } else if (!isVirtualDim) {
          console.warn(`[applyChatModification] "${action.action}" redirigé vers "rename_real_column" : "${targetTable}" est une table réelle, pas une dimension virtuelle.`);
          action = {
            action: 'rename_real_column',
            table: this.stripPrefix(targetTable),
            oldColumn: action.oldColumn ?? action.column,
            newColumn: carriedNewColumn,
            newType: carriedNewType,
            reply: action.reply,
          };
        }
      }

      // Auto-correction du nom de COLONNE cible, une fois l'action et la table définitivement fixées.
      const columnField = COLUMN_FIELD_BY_ACTION[action.action];
      if (columnField && typeof action[columnField] === 'string' && action[columnField].trim()) {
        const columnMatchesMessage = normalizeForMatch(userMessage).includes(normalizeForMatch(action[columnField]));

        if (!columnMatchesMessage) {
          const finalTableFieldForColumn = TABLE_FIELD_BY_ACTION[action.action];
          const targetTableValue = finalTableFieldForColumn ? action[finalTableFieldForColumn] : null;

          if (targetTableValue) {
            const candidates = this.getColumnCandidatesForAction(action.action, targetTableValue, internalCurrentSchema);
            const resolvedColumn = this.resolveColumnFromMessage(userMessage, candidates);
            if (resolvedColumn) {
              console.warn(`[applyChatModification] Colonne "${action[columnField]}" absente du message — corrigée automatiquement en "${resolvedColumn}".`);
              action[columnField] = resolvedColumn;
            }
          }
        }
      }

      const REMOVAL_KEYWORDS = ['retir', 'supprim', 'enlev', 'remov', 'delete', 'drop'];
      const isRemovalAction = action.action?.startsWith('remove_');
      const messageHasRemovalIntent = REMOVAL_KEYWORDS.some((kw) => userMessage.toLowerCase().includes(kw));

      if (isRemovalAction && !messageHasRemovalIntent) {
        console.warn(`[applyChatModification] Action "${action.action}" rejetée : aucun mot-clé de suppression dans "${userMessage}"`);
        return {
          updatedSchema: currentSchema,
          explanation: "Je n'ai pas compris de demande de suppression claire, peux-tu reformuler ?",
          schemaChanged: false,
        };
      }

      const NON_REMOVAL_ACTIONS_WHEN_REMOVAL_EXPECTED = [
        'rename_column', 'rename_table', 'change_column_type',
        'add_dimension_column', 'add_fact_column', 'add_real_column',
        'rename_real_column', 'rename_fact_measure',
        'create_dimension', 'create_fact_table',
      ];
      if (messageHasRemovalIntent && NON_REMOVAL_ACTIONS_WHEN_REMOVAL_EXPECTED.includes(action.action)) {
        console.warn(`[applyChatModification] Le message demande une suppression mais le LLM a répondu "${action.action}" — rejeté.`);
        return {
          updatedSchema: currentSchema,
          explanation: "Ta demande semble être une suppression, mais je n'ai pas pu l'identifier avec certitude. Peux-tu préciser le nom exact de la colonne/table à supprimer ?",
          schemaChanged: false,
        };
      }

      const finalTableField = TABLE_FIELD_BY_ACTION[action.action];
      if (finalTableField && typeof action[finalTableField] === 'string' && action[finalTableField].trim()) {
        const strippedFinal = this.stripPrefix(action[finalTableField]);
        if (!normalizeForMatch(userMessage).includes(normalizeForMatch(strippedFinal))) {
          console.warn(`[applyChatModification] Action "${action.action}" rejetée : cible "${action[finalTableField]}" absente du message et non résolvable.`);
          return {
            updatedSchema: currentSchema,
            explanation: `Je ne trouve pas la table visée dans ton message. Peux-tu préciser son nom exact ?`,
            schemaChanged: false,
          };
        }
      }

      if (action.action === 'answer_question' || action.action === 'unsupported' || action.action === 'none') {
        return {
          updatedSchema: currentSchema,
          explanation: action.reply ?? "Je n'ai pas de réponse claire, peux-tu reformuler ?",
          schemaChanged: false,
        };
      }

      const { newSchema, deterministicExplanation, changed } = this.applyChatAction(internalCurrentSchema, action, userMessage);

      if (!changed) {
        return {
          updatedSchema: currentSchema,
          explanation: `${action.reply ?? ''} ${deterministicExplanation}`.trim(),
          schemaChanged: false,
        };
      }

      const validated = this.validateAndClean(
        {
          dimensions: newSchema.dimensions,
          facts: newSchema.facts,
          confirmedRelations: newSchema.confirmedRelations,
          additionalRelations: [],
          subDimensions: newSchema.subDimensions ?? [],
          virtualFacts: newSchema.virtualFacts ?? [],
          virtualDimensions: newSchema.virtualDimensions ?? [],
          excludedColumns: newSchema.excludedColumns ?? {},
          columnTransformations: newSchema.columnTransformations ?? [],
          tableRenames: newSchema.tableRenames ?? [],
          addedColumns: newSchema.addedColumns ?? {},
        } as any,
        validTableNames,
        validColumnsByTable,
        metadata,
        false,
      );

      const displayed = this.applyDisplayNames(validated);

      return {
        updatedSchema: { ...displayed, rawResponse },
        explanation: `${action.reply ?? ''}\n\n(${deterministicExplanation})`.trim(),
        schemaChanged: true,
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