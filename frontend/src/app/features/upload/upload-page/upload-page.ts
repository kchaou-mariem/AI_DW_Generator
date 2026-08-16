import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { UploadService } from '../../../core/services/upload.service';
import { UploadResponse } from '../../../core/models/schema.model';

@Component({
  selector: 'app-upload-page',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './upload-page.html',
  styleUrl: './upload-page.scss',
})
export class UploadPageComponent implements OnInit {
  databases: string[] = [];
  selectedDatabase = '';
  newDatabaseName = '';
  creatingNewDatabase = false;

  selectedFiles: File[] = [];

  isUploading = false;
  uploadResult: UploadResponse | null = null;
  errorMessage = '';

  constructor(
    private uploadService: UploadService,
    private router: Router,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.loadDatabases();
  }

  loadDatabases(): void {
    this.uploadService.listDatabases().subscribe({
      next: (dbs) => {
        this.databases = dbs;
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.errorMessage = 'Impossible de charger les bases de données : ' + err.message;
        this.cdr.detectChanges();
      },
    });
  }

 onFileSelected(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (input.files) {
    const newFiles = Array.from(input.files);
    // Ajoute aux fichiers déjà sélectionnés, sans dupliquer les noms identiques
    const existingNames = new Set(this.selectedFiles.map((f) => f.name));
    const filesToAdd = newFiles.filter((f) => !existingNames.has(f.name));
    this.selectedFiles = [...this.selectedFiles, ...filesToAdd];
    input.value = ''; // reset l'input pour pouvoir resélectionner le même fichier plus tard si retiré
    this.cdr.detectChanges();
  }
}

removeFile(index: number): void {
  this.selectedFiles.splice(index, 1);
  this.cdr.detectChanges();
}

get hasValidUploadedFile(): boolean {
  return !!this.uploadResult?.files?.some((f) => f.success);
}

  createDatabase(): void {
    if (!this.newDatabaseName.trim()) return;

    this.uploadService.createDatabase(this.newDatabaseName.trim()).subscribe({
      next: () => {
        this.selectedDatabase = this.newDatabaseName.trim();
        this.newDatabaseName = '';
        this.creatingNewDatabase = false;
        this.loadDatabases();
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.errorMessage = 'Erreur lors de la création de la base : ' + err.message;
        this.cdr.detectChanges();
      },
    });
  }

  submitUpload(): void {
    if (!this.selectedDatabase || this.selectedFiles.length === 0) {
      this.errorMessage = 'Sélectionne une base de données et au moins un fichier.';
      this.cdr.detectChanges();
      return;
    }

    this.isUploading = true;
    this.errorMessage = '';
    this.uploadResult = null;
    this.cdr.detectChanges();

    this.uploadService.uploadFiles(this.selectedDatabase, this.selectedFiles).subscribe({
      next: (result) => {
        this.uploadResult = result;
      },
      error: (err) => {
        this.errorMessage = "Erreur lors de l'upload : " + err.message;
        this.isUploading = false;
        this.cdr.detectChanges();
      },
      complete: () => {
        this.isUploading = false;
        this.cdr.detectChanges();
      },
    });
  }

  goToSchemaGeneration(): void {
    this.router.navigate(['/schema', this.selectedDatabase]);
  }
}