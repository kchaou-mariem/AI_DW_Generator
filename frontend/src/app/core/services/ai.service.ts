import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AiSchemaProposal, ChatResponse, SessionResponse } from '../models/schema.model';

export interface DeployResult {
  success: boolean;
  stoppedAtStep: string;
  ddl?: any;
  etl?: any;
  tabular?: any;
}

@Injectable({ providedIn: 'root' })
export class AiService {
  private readonly baseUrl = 'http://localhost:3000/ai/schema';
  private readonly uploadBaseUrl = 'http://localhost:3000/upload'; // ← nouveau


  constructor(private http: HttpClient) {}

  generateSchema(database: string): Observable<AiSchemaProposal> {
    return this.http.get<AiSchemaProposal>(`${this.baseUrl}/${database}`);
  }

  startSession(database: string): Observable<SessionResponse> {
    return this.http.post<SessionResponse>(`${this.baseUrl}/${database}/session`, {});
  }

  startSessionFromExisting(database: string, existingSchema: AiSchemaProposal): Observable<SessionResponse> {
    return this.http.post<SessionResponse>(`${this.baseUrl}/${database}/session/from-existing`, existingSchema);
  }

sendChatMessage(
  database: string,
  sessionId: number,
  message: string,
  currentSchema?: AiSchemaProposal,
): Observable<ChatResponse> {
  return this.http.post<ChatResponse>(`${this.baseUrl}/${database}/session/${sessionId}/chat`, {
    message,
    currentSchema: currentSchema ?? null,
  });
}
  revertToStep(database: string, sessionId: number, stepNumber: number): Observable<ChatResponse> {
    return this.http.post<ChatResponse>(
      `${this.baseUrl}/${database}/session/${sessionId}/revert/${stepNumber}`,
      {},
    );
  }

  getHistory(database: string, sessionId: number): Observable<any[]> {
    return this.http.get<any[]>(`${this.baseUrl}/${database}/session/${sessionId}/history`);
  }

  validateSchema(database: string, schema: AiSchemaProposal): Observable<{ savedAt: string }> {
    return this.http.post<{ savedAt: string }>(`${this.baseUrl}/${database}/validate`, schema);
  }

  getValidatedSchema(database: string): Observable<{ schema: AiSchemaProposal; createdAt: string }> {
    return this.http.get<{ schema: AiSchemaProposal; createdAt: string }>(`${this.baseUrl}/${database}/validate`);
  }

  deployDataWarehouse(database: string, dwDatabase: string): Observable<DeployResult> {
    return this.http.post<DeployResult>(`${this.uploadBaseUrl}/${database}/deploy`, { dwDatabase });
  }
}