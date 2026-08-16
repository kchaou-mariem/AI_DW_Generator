import { Injectable, InternalServerErrorException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as sql from 'mssql';
import csv from 'csv-parser';
import { Readable } from 'stream';
import * as XLSX from 'xlsx';

export interface ColumnMetadata {
  sourceTable: string;
  columnName: string;
  dataType: string;
  cardinality: number;
  nullPercentage: number;
  rowCount: number; // ← AJOUTER (OBLIGATOIRE, pas optionnel)
  sampleValues: string[];
  isLikelyKey: boolean;
  isSensitive: boolean;
  min?: string | number;
  max?: string | number;
  detectedPattern?: string;
  avgLength?: number;
  maxLength?: number;
}

export interface CrossTableRelation {
  tableA: string;
  columnA: string;
  tableB: string;
  columnB: string;
  reason: string;
}

@Injectable()
export class UploadService {
  constructor(private configService: ConfigService) {}

  private getBaseConfig(): sql.config {
  return {
    server: this.configService.get('DB_HOST') ?? 'localhost',
    port: parseInt(this.configService.get('DB_PORT') ?? '1433', 10),
    user: this.configService.get('DB_USERNAME') ?? 'sa',
    password: this.configService.get('DB_PASSWORD'),
    options: { encrypt: false, trustServerCertificate: true },
    requestTimeout: 60000, // ← 60 secondes au lieu du défaut (15s)
    connectionTimeout: 30000, // ← 30 secondes pour établir la connexion
  };
}

  private async getMasterPool(): Promise<sql.ConnectionPool> {
    return sql.connect({ ...this.getBaseConfig(), database: 'master' });
  }

  private async getPool(database: string): Promise<sql.ConnectionPool> {
    return sql.connect({ ...this.getBaseConfig(), database });
  }

  // ---- Gestion des bases ----
  async listDatabases(): Promise<string[]> {
    const pool = await this.getMasterPool();
    try {
      const result = await pool.request().query(`
        SELECT name FROM sys.databases
        WHERE name NOT IN ('master', 'tempdb', 'model', 'msdb')
        ORDER BY name
      `);
      return result.recordset.map((r) => r.name);
    } finally {
      await pool.close();
    }
  }

  async ensureDatabaseExists(database: string): Promise<{ created: boolean }> {
    if (!/^[a-zA-Z0-9_]+$/.test(database)) {
      throw new BadRequestException('Nom de base de données invalide (lettres, chiffres, underscore uniquement)');
    }
    const pool = await this.getMasterPool();
    try {
      const check = await pool.request().query(`SELECT name FROM sys.databases WHERE name = '${database}'`);
      if (check.recordset.length > 0) return { created: false };
      await pool.request().query(`CREATE DATABASE [${database}]`);
      return { created: true };
    } finally {
      await pool.close();
    }
  }

  // ---- Traitement d'un fichier, dans une base précise ----
  async processFile(file: Express.Multer.File, database: string) {
    if (!/^[a-zA-Z0-9_]+$/.test(database)) {
      throw new BadRequestException('Nom de base de données invalide');
    }

    const extension = file.originalname.split('.').pop()?.toLowerCase();
    let rows: any[];

    try {
      switch (extension) {
        case 'csv':
          rows = await this.parseCsv(file.buffer);
          break;
        case 'xlsx':
        case 'xls':
          rows = this.parseExcel(file.buffer);
          break;
        case 'txt':
          rows = await this.parseTxt(file.buffer);
          break;
        default:
          throw new BadRequestException(`Format de fichier non supporté: .${extension}`);
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(`Erreur de lecture du fichier ${file.originalname}: ${err.message}`);
    }

    if (!rows || rows.length === 0) {
      throw new BadRequestException(`Le fichier ${file.originalname} ne contient aucune donnée exploitable`);
    }

    const columns = Object.keys(rows[0]);
    if (columns.length === 0) {
      throw new BadRequestException(`Aucune colonne détectée dans ${file.originalname}`);
    }

    const types = this.detectTypes(columns, rows);
    const tableName = `staging_${file.originalname.split('.')[0].replace(/[^a-zA-Z0-9_]/g, '_')}`;

    const pool = await this.getPool(database);
    try {
      await this.createTable(pool, tableName, types);
      await this.bulkInsert(pool, tableName, columns, rows);
    } catch (err) {
      throw new InternalServerErrorException(
        `Erreur lors de l'écriture en base pour ${file.originalname}: ${err.message}`,
      );
    } finally {
      await pool.close();
    }

    return { tableName, columns, types, rowCount: rows.length, sourceFormat: extension, database };
  }

  // ---- CSV ----
  private parseCsv(buffer: Buffer): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const results: any[] = [];
      Readable.from(buffer)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', () => resolve(results))
        .on('error', reject);
    });
  }

  // ---- Excel ----
  private parseExcel(buffer: Buffer): any[] {
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const firstSheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[firstSheetName];
    return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });
  }

  // ---- TXT ----
  private parseTxt(buffer: Buffer): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const results: any[] = [];
      Readable.from(buffer)
        .pipe(csv({ separator: this.detectDelimiter(buffer) }))
        .on('data', (data) => results.push(data))
        .on('end', () => resolve(results))
        .on('error', reject);
    });
  }

  private detectDelimiter(buffer: Buffer): string {
    const firstLine = buffer.toString('utf-8').split('\n')[0];
    if (firstLine.includes('\t')) return '\t';
    if (firstLine.includes(';')) return ';';
    return ',';
  }

  private detectTypes(columns: string[], rows: any[]): Record<string, string> {
    const types: Record<string, string> = {};
    for (const col of columns) {
      const values = rows.map((r) => r[col]).filter((v) => v !== '' && v != null);
      if (values.length === 0) {
        types[col] = 'VARCHAR(255)';
        continue;
      }

      if (values.every((v) => v instanceof Date)) {
        types[col] = 'DATE';
        continue;
      }
      if (values.every((v) => typeof v === 'number')) {
        types[col] =
          Number.isInteger(values[0]) && values.every((v) => Number.isInteger(v)) ? 'INT' : 'DECIMAL(18,4)';
        continue;
      }

      const strValues = values.map((v) => String(v));
      if (strValues.every((v) => /^-?\d+$/.test(v))) {
        types[col] = 'INT';
      } else if (strValues.every((v) => /^-?\d+(\.\d+)?$/.test(v))) {
        types[col] = 'DECIMAL(18,4)';
      } else if (strValues.every((v) => /^\d{4}-\d{2}-\d{2}/.test(v) || /^\d{2}\/\d{2}\/\d{4}/.test(v))) {
        types[col] = 'DATE';
      } else {
        const maxLen = Math.max(...strValues.map((v) => v.length), 50);
        types[col] = `VARCHAR(${Math.min(maxLen + 20, 4000)})`;
      }
    }
    return types;
  }

  private async createTable(pool: sql.ConnectionPool, tableName: string, types: Record<string, string>) {
    const columnsDef = Object.entries(types)
      .map(([col, type]) => `[${col}] ${type} NULL`)
      .join(', ');
    const query = `
      IF OBJECT_ID('${tableName}', 'U') IS NOT NULL DROP TABLE ${tableName};
      CREATE TABLE ${tableName} (${columnsDef});
    `;
    await pool.request().query(query);
  }

  private async bulkInsert(pool: sql.ConnectionPool, tableName: string, columns: string[], rows: any[]) {
    const colList = columns.map((c) => `[${c}]`).join(', ');
    const batchSize = 500;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const values = batch
        .map((row) => {
          const rowValues = columns.map((c) => {
            let val = row[c] ?? '';
            if (val instanceof Date) {
              val = val.toISOString().split('T')[0];
            }
            return `'${String(val).replace(/'/g, "''")}'`;
          });
          return `(${rowValues.join(', ')})`;
        })
        .join(', ');
      await pool.request().query(`INSERT INTO ${tableName} (${colList}) VALUES ${values}`);
    }
  }

  // ---- Métadonnées à la demande, lues depuis SQL Server ----
  async buildMetadataForDatabase(database: string): Promise<ColumnMetadata[][]> {
    if (!/^[a-zA-Z0-9_]+$/.test(database)) {
      throw new BadRequestException('Nom de base de données invalide');
    }

    const pool = await this.getPool(database);
    try {
      const tablesResult = await pool.request().query(`
        SELECT TABLE_NAME
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_NAME LIKE 'staging_%' AND TABLE_TYPE = 'BASE TABLE'
      `);

      const allMetadata: ColumnMetadata[][] = [];
      for (const row of tablesResult.recordset) {
        const metadata = await this.buildMetadataForTable(pool, row.TABLE_NAME);
        allMetadata.push(metadata);
      }
      return allMetadata;
    } finally {
      await pool.close();
    }
  }

  private async buildMetadataForTable(pool: sql.ConnectionPool, tableName: string): Promise<ColumnMetadata[]> {
  const columnsResult = await pool.request().query(`
    SELECT COLUMN_NAME, DATA_TYPE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = '${tableName}'
    ORDER BY ORDINAL_POSITION
  `);

  const [{ total }] = (await pool.request().query(`SELECT COUNT(*) as total FROM [${tableName}]`)).recordset;

  const metadata: ColumnMetadata[] = [];

  for (const col of columnsResult.recordset) {
    const colName = col.COLUMN_NAME;
    const sqlType = col.DATA_TYPE;

    const [stats] = (await pool.request().query(`
      SELECT
        COUNT(DISTINCT [${colName}]) as cardinality,
        SUM(CASE WHEN [${colName}] IS NULL THEN 1 ELSE 0 END) as nullCount
      FROM [${tableName}]
    `)).recordset;

    const isSensitiveByUniqueness = this.isSensitiveColumn(sqlType, stats.cardinality, total);

    const samplesResult = await pool.request().query(`
      SELECT DISTINCT TOP 3 [${colName}] as val
      FROM [${tableName}]
      WHERE [${colName}] IS NOT NULL
    `);
    const rawSamples = samplesResult.recordset.map((r) => this.formatSampleValue(r.val));

    let isSensitive = isSensitiveByUniqueness;
    let detectedPattern: string | undefined;

    if (sqlType.toLowerCase().includes('varchar')) {
      detectedPattern = this.detectPattern(rawSamples.map(String));
      if (detectedPattern === 'email' || detectedPattern === 'phone') {
        isSensitive = true;
      }
    }

    const meta: ColumnMetadata = {
      sourceTable: tableName,
      columnName: colName,
      dataType: sqlType,
      cardinality: stats.cardinality,
      nullPercentage: total > 0 ? Math.round((stats.nullCount / total) * 100) : 0,
      rowCount: total, // ← AJOUT OBLIGATOIRE
      sampleValues: isSensitive ? [] : rawSamples.map(String),
      isLikelyKey: total > 0 && stats.cardinality === total - stats.nullCount,
      isSensitive,
    };
    if (detectedPattern) meta.detectedPattern = detectedPattern;

    // Longueur moyenne/max des chaînes
    if (sqlType.toLowerCase().includes('varchar')) {
      const [lengthStats] = (await pool.request().query(`
        SELECT
          AVG(CAST(LEN([${colName}]) AS FLOAT)) as avgLen,
          MAX(LEN([${colName}])) as maxLen
        FROM [${tableName}]
        WHERE [${colName}] IS NOT NULL
      `)).recordset;
      if (lengthStats.avgLen !== null) {
        meta.avgLength = Math.round(lengthStats.avgLen * 10) / 10;
        meta.maxLength = lengthStats.maxLen;
      }
    }

    if (['int', 'decimal', 'numeric', 'float', 'date', 'datetime'].includes(sqlType.toLowerCase())) {
      const [minMax] = (await pool.request().query(`
        SELECT MIN([${colName}]) as minVal, MAX([${colName}]) as maxVal
        FROM [${tableName}]
        WHERE [${colName}] IS NOT NULL
      `)).recordset;
      if (minMax.minVal !== null) {
        meta.min = this.formatSampleValue(minMax.minVal);
        meta.max = this.formatSampleValue(minMax.maxVal);
      }
    }

    metadata.push(meta);
  }

  return metadata;
}

  private formatSampleValue(val: any): string | number {
    if (val instanceof Date) {
      return val.toISOString().split('T')[0];
    }
    return val;
  }

  private isSensitiveColumn(dataType: string, cardinality: number, totalRows: number): boolean {
    const isTextType = dataType.toLowerCase().includes('varchar');
    if (!isTextType) return false;
    const uniquenessRatio = totalRows > 0 ? cardinality / totalRows : 0;
    return uniquenessRatio > 0.8;
  }

  private detectPattern(values: string[]): string | undefined {
    const sample = values.slice(0, 20);
    if (sample.length === 0) return undefined;
    if (sample.every((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))) return 'email';
    if (sample.every((v) => /^[\d\s+().-]{8,20}$/.test(v))) return 'phone';
    if (sample.every((v) => /^\d{4,6}$/.test(v))) return 'postal_code';
    if (sample.every((v) => /^https?:\/\//.test(v))) return 'url';
    return undefined;
  }

  private isNumericType(dataType: string): boolean {
    return ['int', 'decimal', 'numeric', 'float', 'bigint', 'smallint', 'tinyint'].some((t) =>
      dataType.toLowerCase().includes(t),
    );
  }

  // ---- Relations entre tables (pré-filtre heuristique) ----
  detectCrossTableRelations(allMetadata: ColumnMetadata[][]): CrossTableRelation[] {
    const relations: CrossTableRelation[] = [];
    const flatMeta = allMetadata.flat();

    for (let i = 0; i < flatMeta.length; i++) {
      for (let j = i + 1; j < flatMeta.length; j++) {
        const colA = flatMeta[i];
        const colB = flatMeta[j];

        if (colA.sourceTable === colB.sourceTable) continue;

        const nameMatch = this.normalizeColumnName(colA.columnName) === this.normalizeColumnName(colB.columnName);

        const eitherIsNumeric = this.isNumericType(colA.dataType) || this.isNumericType(colB.dataType);
        const sampleOverlap = !eitherIsNumeric && colA.sampleValues.some((v) => colB.sampleValues.includes(v));

        if (nameMatch || sampleOverlap) {
          relations.push({
            tableA: colA.sourceTable,
            columnA: colA.columnName,
            tableB: colB.sourceTable,
            columnB: colB.columnName,
            reason: nameMatch ? 'nom_de_colonne_similaire' : 'valeurs_communes_detectees',
          });
        }
      }
    }

    return relations;
  }

  private normalizeColumnName(name: string): string {
    return name.toLowerCase().replace(/[_\s-]/g, '');
  }

  async saveSchemaValidation(database: string, schema: unknown): Promise<{ savedAt: string }> {
  if (!/^[a-zA-Z0-9_]+$/.test(database)) {
    throw new BadRequestException('Nom de base de données invalide');
  }

  const pool = await this.getPool(database);
  try {
    await pool.request().query(`
      IF OBJECT_ID('dw_schema_validation', 'U') IS NULL
      CREATE TABLE dw_schema_validation (
        id INT IDENTITY(1,1) PRIMARY KEY,
        schema_json NVARCHAR(MAX) NOT NULL,
        created_at DATETIME DEFAULT GETDATE()
      );
    `);

    const jsonString = JSON.stringify(schema).replace(/'/g, "''");
    const result = await pool
      .request()
      .query(`INSERT INTO dw_schema_validation (schema_json) OUTPUT INSERTED.created_at VALUES ('${jsonString}')`);

    return { savedAt: result.recordset[0].created_at };
  } finally {
    await pool.close();
  }
}

async getLatestSchemaValidation(database: string): Promise<{ schema: unknown; createdAt: string } | null> {
  if (!/^[a-zA-Z0-9_]+$/.test(database)) {
    throw new BadRequestException('Nom de base de données invalide');
  }

  const pool = await this.getPool(database);
  try {
    const tableExists = await pool.request().query(`
      SELECT OBJECT_ID('dw_schema_validation', 'U') as id
    `);
    if (!tableExists.recordset[0].id) return null;

    const result = await pool.request().query(`
      SELECT TOP 1 schema_json, created_at
      FROM dw_schema_validation
      ORDER BY created_at DESC
    `);
    if (result.recordset.length === 0) return null;

    return {
      schema: JSON.parse(result.recordset[0].schema_json),
      createdAt: result.recordset[0].created_at,
    };
  } finally {
    await pool.close();
  }
}
async initChatSession(database: string, initialSchema: unknown): Promise<{ sessionId: number }> {
  const pool = await this.getPool(database);
  try {
    await pool.request().query(`
      IF OBJECT_ID('dw_schema_chat_history', 'U') IS NULL
      CREATE TABLE dw_schema_chat_history (
        id INT IDENTITY(1,1) PRIMARY KEY,
        session_id INT NOT NULL,
        step_number INT NOT NULL,
        schema_json NVARCHAR(MAX) NOT NULL,
        user_message NVARCHAR(MAX) NULL,
        ai_explanation NVARCHAR(MAX) NULL,
        created_at DATETIME DEFAULT GETDATE()
      );
    `);

    const sessionResult = await pool.request().query(`
      SELECT ISNULL(MAX(session_id), 0) + 1 as newSessionId FROM dw_schema_chat_history
    `);
    const sessionId = sessionResult.recordset[0].newSessionId;

    const jsonString = JSON.stringify(initialSchema).replace(/'/g, "''");
    await pool.request().query(`
      INSERT INTO dw_schema_chat_history (session_id, step_number, schema_json, user_message, ai_explanation)
      VALUES (${sessionId}, 0, '${jsonString}', NULL, 'Proposition initiale de l''IA')
    `);

    return { sessionId };
  } finally {
    await pool.close();
  }
}
async initChatSessionFromExisting(database: string, existingSchema: unknown): Promise<{ sessionId: number }> {
  if (!/^[a-zA-Z0-9_]+$/.test(database)) {
    throw new BadRequestException('Nom de base de données invalide');
  }

  const pool = await this.getPool(database);
  try {
    await pool.request().query(`
      IF OBJECT_ID('dw_schema_chat_history', 'U') IS NULL
      CREATE TABLE dw_schema_chat_history (
        id INT IDENTITY(1,1) PRIMARY KEY,
        session_id INT NOT NULL,
        step_number INT NOT NULL,
        schema_json NVARCHAR(MAX) NOT NULL,
        user_message NVARCHAR(MAX) NULL,
        ai_explanation NVARCHAR(MAX) NULL,
        created_at DATETIME DEFAULT GETDATE()
      );
    `);

    const sessionResult = await pool.request().query(`
      SELECT ISNULL(MAX(session_id), 0) + 1 as newSessionId FROM dw_schema_chat_history
    `);
    const sessionId = sessionResult.recordset[0].newSessionId;

    const jsonString = JSON.stringify(existingSchema).replace(/'/g, "''");
    await pool.request().query(`
      INSERT INTO dw_schema_chat_history (session_id, step_number, schema_json, user_message, ai_explanation)
      VALUES (${sessionId}, 0, '${jsonString}', NULL, 'Reprise d''un schéma existant')
    `);

    return { sessionId };
  } finally {
    await pool.close();
  }
}

async addChatStep(
  database: string,
  sessionId: number,
  newSchema: unknown,
  userMessage: string,
  aiExplanation: string,
): Promise<{ stepNumber: number }> {
  const pool = await this.getPool(database);
  try {
    const stepResult = await pool.request().query(`
      SELECT ISNULL(MAX(step_number), -1) + 1 as newStep
      FROM dw_schema_chat_history WHERE session_id = ${sessionId}
    `);
    const stepNumber = stepResult.recordset[0].newStep;

    const jsonString = JSON.stringify(newSchema).replace(/'/g, "''");
    const messageEscaped = userMessage.replace(/'/g, "''");
    const explanationEscaped = aiExplanation.replace(/'/g, "''");

    await pool.request().query(`
      INSERT INTO dw_schema_chat_history (session_id, step_number, schema_json, user_message, ai_explanation)
      VALUES (${sessionId}, ${stepNumber}, '${jsonString}', '${messageEscaped}', '${explanationEscaped}')
    `);

    return { stepNumber };
  } finally {
    await pool.close();
  }
}

async getChatHistory(database: string, sessionId: number): Promise<any[]> {
  const pool = await this.getPool(database);
  try {
    const result = await pool.request().query(`
      SELECT step_number, schema_json, user_message, ai_explanation, created_at
      FROM dw_schema_chat_history
      WHERE session_id = ${sessionId}
      ORDER BY step_number ASC
    `);
    return result.recordset.map((r) => ({
      stepNumber: r.step_number,
      schema: JSON.parse(r.schema_json),
      userMessage: r.user_message,
      aiExplanation: r.ai_explanation,
      createdAt: r.created_at,
    }));
  } finally {
    await pool.close();
  }
}

async getSchemaAtStep(database: string, sessionId: number, stepNumber: number): Promise<unknown | null> {
  const pool = await this.getPool(database);
  try {
    const result = await pool.request().query(`
      SELECT schema_json FROM dw_schema_chat_history
      WHERE session_id = ${sessionId} AND step_number = ${stepNumber}
    `);
    if (result.recordset.length === 0) return null;
    return JSON.parse(result.recordset[0].schema_json);
  } finally {
    await pool.close();
  }
}
}