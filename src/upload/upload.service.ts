// import { Injectable } from '@nestjs/common';
// import { DataSource } from 'typeorm';
// import csv from 'csv-parser';
// import { Readable } from 'stream'; // transformer le buffer du fichier en un flux lisible pour le parser CSV

// @Injectable()
// export class UploadService {
//   constructor(private dataSource: DataSource) {}

//   async processFile(file: Express.Multer.File) { // Méthode principale :  reçoit le fichier envoyé par l'utilisateur et le traite
//     const rows = await this.parseCsv(file.buffer); // transfome le buffer du fichier en un tableau d'objets
//     if (rows.length === 0) throw new Error('Fichier vide');

//     const columns = Object.keys(rows[0]); // récupère les noms des colonnes à partir de la première ligne du fichier CSV
//     const types = this.detectTypes(columns, rows);// détecte les types de données pour chaque colonne en fonction des valeurs présentes dans le fichier CSV
//     const tableName = `staging_${file.originalname.split('.')[0].replace(/[^a-zA-Z0-9_]/g, '_')}`; // génère un nom de table unique basé sur le nom du fichier, en remplaçant les caractères non alphanumériques par des underscores

//     await this.createTable(tableName, types); // crée la table dans la base de données avec les colonnes et types détectés
//     await this.bulkInsert(tableName, columns, rows);// insère les données du fichier CSV dans la table nouvellement créée en utilisant des insertions par lots pour améliorer les performances

//     return { tableName, columns, types, rowCount: rows.length };
//   }

//   private parseCsv(buffer: Buffer): Promise<any[]> { // Méthode utilitaire :  parse le buffer du fichier CSV et retourne un tableau d'objets représentant les lignes du fichier
//     return new Promise((resolve, reject) => { 
//       const results: any[] = [];
//       Readable.from(buffer)
//         .pipe(csv())
//         .on('data', (data) => results.push(data))
//         .on('end', () => resolve(results))
//         .on('error', reject);
//     });
//   }
import { Injectable, InternalServerErrorException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import csv from 'csv-parser';
import { Readable } from 'stream';
import * as XLSX from 'xlsx';
import * as sql from 'mssql';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class UploadService {
  constructor(
    private dataSource: DataSource,
    private configService: ConfigService, // ← nouveau, pour lire le .env
  ) {}

  private getBaseConfig(): sql.config {
    return {
      server: this.configService.get('DB_HOST') ?? 'localhost',
      port: parseInt(this.configService.get('DB_PORT') ?? '1433', 10),
      user: this.configService.get('DB_USERNAME') ?? 'sa',
      password: this.configService.get('DB_PASSWORD'),
      options: { encrypt: false, trustServerCertificate: true },
    };
  }

  // Connexion au serveur SANS base précise (pour lister/créer des bases)
  private async getMasterPool(): Promise<sql.ConnectionPool> {
    return sql.connect({ ...this.getBaseConfig(), database: 'master' });
  }

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
    // Sécurité basique : n'accepte que des noms de base "propres" (lettres, chiffres, underscore)
    if (!/^[a-zA-Z0-9_]+$/.test(database)) {
      throw new BadRequestException('Nom de base de données invalide (lettres, chiffres, underscore uniquement)');
    }

    const pool = await this.getMasterPool();
    try {
      const check = await pool.request().query(`
        SELECT name FROM sys.databases WHERE name = '${database}'
      `);
      if (check.recordset.length > 0) {
        return { created: false }; // existe déjà
      }
      await pool.request().query(`CREATE DATABASE [${database}]`);
      return { created: true };
    } finally {
      await pool.close();
    }
  }


  async processFile(file: Express.Multer.File) {
    const extension = file.originalname.split('.').pop()?.toLowerCase();
    let rows: any[];

    // Parsing
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

    // Création table + insertion
    try {
      await this.createTable(tableName, types);
      await this.bulkInsert(tableName, columns, rows);
    } catch (err) {
      throw new InternalServerErrorException(
        `Erreur lors de l'écriture en base pour ${file.originalname}: ${err.message}`,
      );
    }

    return { tableName, columns, types, rowCount: rows.length, sourceFormat: extension };
  }

  // ---- CSV ----
  private parseCsv(buffer: Buffer): Promise<any[]> { // Méthode utilitaire :  parse le buffer du fichier CSV et retourne un tableau d'objets représentant les lignes du fichier
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
  private parseExcel(buffer: Buffer): any[] { // Méthode utilitaire :  parse le buffer du fichier Excel et retourne un tableau d'objets représentant les lignes du fichier
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const firstSheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[firstSheetName];
    return XLSX.utils.sheet_to_json(sheet, { defval: '' }); // defval évite les undefined
  }

  // ---- TXT (on suppose délimité, ex: tabulation ou point-virgule) ----
  private parseTxt(buffer: Buffer): Promise<any[]> { // Méthode utilitaire :  parse le buffer du fichier TXT et retourne un tableau d'objets représentant les lignes du fichier
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
    return ','; // par défaut
  }

  private detectTypes(columns: string[], rows: any[]): Record<string, string> {
    const types: Record<string, string> = {};
    for (const col of columns) {
      const values = rows.map((r) => r[col]).filter((v) => v !== '' && v != null);
      if (values.every((v) => /^-?\d+$/.test(v))) {
        types[col] = 'INT';
      } else if (values.every((v) => /^-?\d+\.\d+$/.test(v))) {
        types[col] = 'DECIMAL(18,2)';
      } else if (values.every((v) => /^\d{4}-\d{2}-\d{2}/.test(v) || /^\d{2}\/\d{2}\/\d{4}/.test(v))) {
        types[col] = 'DATE';
      } else {
        const maxLen = Math.max(...values.map((v) => String(v).length), 50);
        types[col] = `VARCHAR(${Math.min(maxLen + 20, 4000)})`;
      }
    }
    return types;
  }

  private async createTable(tableName: string, types: Record<string, string>) {
    const columnsDef = Object.entries(types)
      .map(([col, type]) => `[${col}] ${type} NULL`)
      .join(', ');
    const sql = `
      IF OBJECT_ID('${tableName}', 'U') IS NOT NULL DROP TABLE ${tableName};
      CREATE TABLE ${tableName} (${columnsDef});
    `;
    await this.dataSource.query(sql);
  }

  private async bulkInsert(tableName: string, columns: string[], rows: any[]) {
    const colList = columns.map((c) => `[${c}]`).join(', ');
    const batchSize = 500;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const values = batch
        .map((row) => `(${columns.map((c) => `'${String(row[c] ?? '').replace(/'/g, "''")}'`).join(', ')})`)
        .join(', ');
      await this.dataSource.query(`INSERT INTO ${tableName} (${colList}) VALUES ${values}`);
    }
  }
}