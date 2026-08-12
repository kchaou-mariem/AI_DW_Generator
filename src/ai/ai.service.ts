import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { UploadService, ColumnMetadata, CrossTableRelation } from '../upload/upload.service';

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
  private readonly MODEL = 'qwen2.5:7b-instruct';
  private readonly MAX_RETRIES = 3;
  private readonly DERIVED_DIMENSION_PREFIXES = ['dimtemps', 'dimdate', 'dimtime', 'dimcalendar'];

  constructor(private uploadService: UploadService) {}

  private toDisplayName(tableName: string): string {
  return tableName.replace(/^staging_/i, '');
}

private applyDisplayNames(result: Omit<AiSchemaProposal, 'rawResponse'>): Omit<AiSchemaProposal, 'rawResponse'> {
  const rename = (t: string) => this.toDisplayName(t);

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
  const candidates: string[] = [];
  for (const table of metadata) {
    for (const col of table) {
      if (
        col.dataType.toLowerCase().includes('varchar') &&
        !col.isLikelyKey &&
        col.cardinality > 1 &&
        col.cardinality <= 15
      ) {
        candidates.push(`${col.sourceTable}.${col.columnName} (${col.cardinality} valeurs distinctes)`);
      }
    }
  }
  return candidates.length > 0 ? candidates.join(', ') : 'aucun candidat détecté';
}

  private buildPrompt(metadata: ColumnMetadata[][], relations: CrossTableRelation[], hasDateColumn: boolean): string {
  const dateRule = hasDateColumn
    ? `\n2b. Des colonnes de type date existent dans les données. Si pertinent, propose une dimension temporelle nommée exactement "DimTemps" dans "dimensions" — cette table est calculée automatiquement plus tard, elle n'a pas besoin d'exister dans les métadonnées fournies. Ne propose PAS de relation vers DimTemps toi-même, elle sera générée automatiquement.`
    : '';

  const subDimCandidates = this.findSubDimensionCandidates(metadata);

  return `Tu es un architecte BI expert en modélisation de data warehouse.

Métadonnées des tables de staging :
${JSON.stringify(metadata)}

Relations déjà détectées par un pré-filtre :
${JSON.stringify(relations)}

RÈGLES STRICTES à respecter absolument :
1. CHAQUE table de staging présente dans les métadonnées doit apparaître EXACTEMENT UNE FOIS, soit dans "dimensions", soit dans "facts". Ne jamais oublier une table, ne jamais en dupliquer une. Utilise EXCLUSIVEMENT les noms de tables tels qu'ils apparaissent dans les métadonnées, jamais un nom renommé.
2. N'invente JAMAIS de nom de table ou de colonne qui n'existe pas dans les métadonnées fournies, sauf la dimension temporelle décrite ci-dessous.${dateRule}
3. Chaque relation doit utiliser des noms de tables et colonnes EXACTEMENT identiques à ceux des métadonnées (respecte la casse), sauf pour "DimTemps".
4. "dimensions" et "facts" doivent être des tableaux de CHAÎNES DE CARACTÈRES SIMPLES, jamais des objets.
5. INTERDIT : ne propose jamais de relation directe entre deux dimensions qui sont TOUTES LES DEUX déjà reliées directement à une table de faits.
6. Colonnes candidates pour une extraction en sous-dimension (faible cardinalité déjà détectée par calcul) : ${subDimCandidates}.
Si l'une d'elles mérite vraiment d'être extraite (catégorie métier claire, forte répétition), propose-la au format :
{"subDimensions": [{"name": "DimNomChoisi", "parentDimension": "nom_table_du_candidat", "sourceColumn": "nom_colonne_du_candidat", "generatedPrimaryKey": "NomCleGeneree"}]}
N'invente RIEN en dehors de cette liste de candidats. IMPORTANT : ignore complètement "DimTemps" pour cette règle — la dimension temporelle est gérée séparément et automatiquement, ne la mentionne jamais dans "subDimensions".
7. IMPORTANT — Constellation de faits : si tu identifies PLUSIEURS tables contenant chacune des mesures numériques agrégeables, tu DOIS les classer TOUTES dans "facts". Dans ce cas, assure-toi qu'au moins une dimension est reliée aux DEUX tables de faits.
8. Réponds STRICTEMENT en JSON valide, sans texte avant/après, selon ce format exact :

{"dimensions":["..."],"facts":["..."],"confirmedRelations":[{"tableA":"...","columnA":"...","tableB":"...","columnB":"...","reason":"..."}],"additionalRelations":[{"tableA":"...","columnA":"...","tableB":"...","columnB":"...","reason":"..."}],"subDimensions":[]}`;
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
  subDimensions: unknown[];
} {
  const cleaned = rawResponse.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);
  return {
    dimensions: parsed.dimensions ?? [],
    facts: parsed.facts ?? [],
    confirmedRelations: parsed.confirmedRelations ?? [],
    additionalRelations: parsed.additionalRelations ?? [],
    subDimensions: parsed.subDimensions ?? [],
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
): SubDimension[] {
  if (!Array.isArray(rawSubDimensions)) return [];

  const usedNames = new Set<string>();

  return rawSubDimensions.filter((sd: any): sd is SubDimension => {
    if (!sd || !sd.name || !sd.parentDimension || !sd.sourceColumn || !sd.generatedPrimaryKey) {
      warnings.push(`Sous-dimension ignorée (champs manquants): ${JSON.stringify(sd)}`);
      return false;
    }

    // Nouveau : rejette explicitement toute confusion avec DimTemps
    if (String(sd.name).toLowerCase().includes('dimtemps') || String(sd.parentDimension).toLowerCase().includes('dimtemps')) {
      warnings.push(`Sous-dimension ignorée (confusion avec DimTemps, géré séparément): ${sd.name}`);
      return false;
    }

    if (!cleanDimensions.includes(sd.parentDimension)) {
      warnings.push(`Sous-dimension ignorée (parent "${sd.parentDimension}" n'est pas une dimension valide): ${sd.name}`);
      return false;
    }

    const parentCols = validColumnsByTable.get(sd.parentDimension);
    if (!parentCols || !parentCols.has(sd.sourceColumn)) {
      warnings.push(
        `Sous-dimension ignorée (colonne "${sd.sourceColumn}" inexistante dans "${sd.parentDimension}"): ${sd.name}`,
      );
      return false;
    }

    if (cleanDimensions.includes(sd.name) || usedNames.has(sd.name)) {
      warnings.push(`Sous-dimension ignorée (nom "${sd.name}" en conflit avec une table existante)`);
      return false;
    }

    usedNames.add(sd.name);
    return true;
  });
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

    for (const tableName of validTableNames) {
      if (!seen.has(tableName)) {
        warnings.push(`Table ${tableName} non classée par l'IA — ajoutée en dimension par défaut`);
        cleanDimensions.push(tableName);
        seen.add(tableName);
      }
    }

    if (cleanFacts.length === 0) {
      const fallbackFact = this.detectLikelyFactTable(metadata);
      if (fallbackFact && cleanDimensions.includes(fallbackFact)) {
        warnings.push(`Aucun fait identifié par l'IA — ${fallbackFact} reclassée en fait par heuristique de secours`);
        cleanDimensions.splice(cleanDimensions.indexOf(fallbackFact), 1);
        cleanFacts.push(fallbackFact);
      }
    }

   

    // --- Validation structurelle des relations proposées par l'IA ---
    // Note : toute relation impliquant DimTemps proposée par l'IA est ignorée ici,
    // car DimTemps est gérée intégralement par code juste après (colonnes + relation générées automatiquement)
    const structurallyValid = (r: any): boolean => {
      if (!r || !r.tableA || !r.columnA || !r.tableB || !r.columnB) {
        warnings.push(`Relation incomplète ignorée: ${JSON.stringify(r)}`);
        return false;
      }
      if (r.tableA.toLowerCase().includes('dimtemps') || r.tableB.toLowerCase().includes('dimtemps')) {
        warnings.push(`Relation vers DimTemps ignorée (générée automatiquement, pas par l'IA)`);
        return false;
      }
      const colsA = validColumnsByTable.get(r.tableA);
      if (!colsA || !colsA.has(r.columnA)) {
        warnings.push(`Relation invalide ignorée (colonne inexistante ${r.tableA}.${r.columnA})`);
        return false;
      }
      const colsB = validColumnsByTable.get(r.tableB);
      if (!colsB || !colsB.has(r.columnB)) {
        warnings.push(`Relation invalide ignorée (colonne inexistante ${r.tableB}.${r.columnB})`);
        return false;
      }
      return true;
    };

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

    const confirmedRelations = parsed.confirmedRelations
    .filter(structurallyValid)
    .filter(isValidRelation)
    .map((r: any) => ({ ...r, reason: this.computeActualReason(r.tableA, r.columnA, r.tableB, r.columnB) }));

    const additionalRelations = parsed.additionalRelations
    .filter(structurallyValid)
    .filter(isValidRelation)
    .map((r: any) => ({ ...r, reason: this.computeActualReason(r.tableA, r.columnA, r.tableB, r.columnB) }));

     // --- Vérification de cohérence pour la constellation de faits ---
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

        // Suggestion automatique : cherche une colonne commune entre les tables de faits
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

    // --- Génération automatique et complète de DimTemps (jamais laissée à l'IA) ---
    const factTableMeta = metadata.find((table) => cleanFacts.includes(table[0]?.sourceTable));
    const dateColumnInFact = factTableMeta?.find((col) => col.dataType.toLowerCase().includes('date'));
    const hasDateInFact = Boolean(dateColumnInFact);

    let generatedDimensions: any[] = [];
    let factColumnTransformations: any[] = [];
    const finalConfirmedRelations = [...confirmedRelations];

    if (hasDateInFact && !cleanDimensions.some((d) => d.toLowerCase().includes('dimtemps'))) {
      warnings.push('DimTemps ajoutée automatiquement (colonne date détectée dans la table de faits)');
      cleanDimensions.push('DimTemps');
    }

    const dimTempsPresent = cleanDimensions.some((d) => d.toLowerCase().includes('dimtemps'));
    if (dimTempsPresent && dateColumnInFact && cleanFacts.length > 0) {
      const { generatedDimension, factTransformation, relation } = this.buildDimTempsStructure(
        cleanFacts[0],
        dateColumnInFact.columnName,
      );
      generatedDimensions.push(generatedDimension);
      factColumnTransformations.push(factTransformation);
      finalConfirmedRelations.push(relation);
      warnings.push(
        `Structure DimTemps générée : ${dateColumnInFact.columnName} → ${factTransformation.newColumn} (FK vers DimTemps.DateKey)`,
      );
    }

   // --- Validation des sous-dimensions proposées par l'IA ---
    const subDimensions = this.validateSubDimensions(
      (parsed as any).subDimensions,
      validColumnsByTable,
      cleanDimensions,
      warnings,
    );

   const tableAttributes = this.buildTableAttributes(
  cleanDimensions,
  cleanFacts,
  metadata,
  generatedDimensions,
  subDimensions,
);

return {
  dimensions: cleanDimensions,
  facts: cleanFacts,
  confirmedRelations: finalConfirmedRelations,
  additionalRelations,
  generatedDimensions,
  factColumnTransformations,
  subDimensions,
  tableAttributes, // ← nouveau
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
          subDimensions: currentSchema.subDimensions ?? [],
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