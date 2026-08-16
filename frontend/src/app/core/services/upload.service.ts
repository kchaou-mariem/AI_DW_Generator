import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { UploadResponse } from '../models/schema.model';

@Injectable({ providedIn: 'root' })
export class UploadService {
  private readonly baseUrl = 'http://localhost:3000/upload';

  constructor(private http: HttpClient) {}

  listDatabases(): Observable<string[]> {
    return this.http.get<string[]>(`${this.baseUrl}/databases`);
  }

  createDatabase(name: string): Observable<{ created: boolean }> {
    return this.http.post<{ created: boolean }>(`${this.baseUrl}/databases`, { name });
  }

  uploadFiles(database: string, files: File[]): Observable<UploadResponse> {
    const formData = new FormData();
    formData.append('database', database);
    files.forEach((file) => formData.append('files', file));

    return this.http.post<UploadResponse>(this.baseUrl, formData);
  }

  getMetadata(database: string): Observable<any> {
    return this.http.get<any>(`${this.baseUrl}/metadata/${database}`);
  }
}