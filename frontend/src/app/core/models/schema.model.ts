export interface ColumnAttribute {
  name: string;
  type: string;
}

export interface CrossTableRelation {
  tableA: string;
  columnA: string;
  tableB: string;
  columnB: string;
  reason: string;
}

export interface SubDimension {
  name: string;
  parentDimension: string;
  sourceColumn: string;
  generatedPrimaryKey: string;
}

export interface GeneratedDimension {
  name: string;
  columns: { name: string; type: string; isPrimaryKey: boolean }[];
  sourceColumn?: string;
}

export interface FactColumnTransformation {
  factTable: string;
  originalColumn: string;
  newColumn: string;
  newColumnType: string;
  referencesTable: string;
  referencesColumn: string;
}

export interface AiSchemaProposal {
  dimensions: string[];
  facts: string[];
  confirmedRelations: CrossTableRelation[];
  additionalRelations: CrossTableRelation[];
  generatedDimensions: GeneratedDimension[];
  factColumnTransformations: FactColumnTransformation[];
  subDimensions: SubDimension[];
  tableAttributes: Record<string, ColumnAttribute[]>;
  rawResponse: string;
  warnings: string[];
}

export interface ChatResponse {
  stepNumber: number;
  schema: AiSchemaProposal;
  explanation: string;
}

export interface SessionResponse {
  sessionId: number;
  schema: AiSchemaProposal;
}

export interface UploadResult {
  success: boolean;
  fileName: string;
  tableName?: string;
  columns?: string[];
  rowCount?: number;
  error?: string;
}

export interface UploadResponse {
  database: string;
  files: UploadResult[];
}