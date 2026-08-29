import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { map, catchError } from 'rxjs/operators';
import { UploadService } from '../../../core/services/upload.service';
import { AiService } from '../../../core/services/ai.service';
import { UploadResponse } from '../../../core/models/schema.model';
import { ToastService } from '../../../core/services/toast.service';
interface DatabaseStatus {
  hasValidatedSchema: boolean;
  hasStagingTables: boolean;
}

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

  // ---- Nouveau : statut de la base sélectionnée ----
  checkingStatus = false;
  databaseStatus: DatabaseStatus | null = null;
  showUploadSection = false;

  constructor(
    private uploadService: UploadService,
    private aiService: AiService,
    private router: Router,
    private cdr: ChangeDetectorRef,
    private toastService: ToastService,
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

  // ---- Nouveau : appelé quand l'utilisateur choisit une base existante ----
  onDatabaseSelected(): void {
    this.uploadResult = null;
    this.errorMessage = '';
    this.showUploadSection = false;
    this.databaseStatus = null;

    if (!this.selectedDatabase) return;

    this.checkingStatus = true;
    this.cdr.detectChanges();

    forkJoin({
      validated: this.aiService.getValidatedSchema(this.selectedDatabase).pipe(
        map(() => true),
        catchError(() => of(false)),
      ),
      hasTables: this.uploadService.getMetadata(this.selectedDatabase).pipe(
        map((res) => (res?.tables?.length ?? 0) > 0),
        catchError(() => of(false)),
      ),
    }).subscribe({
      next: ({ validated, hasTables }) => {
        this.databaseStatus = { hasValidatedSchema: validated, hasStagingTables: hasTables };
        // Si la base est totalement vide (rien à voir, rien à générer), on ouvre direct l'upload
        this.showUploadSection = !validated && !hasTables;
        this.checkingStatus = false;
        this.cdr.detectChanges();
      },
      error: () => {
        this.checkingStatus = false;
        this.cdr.detectChanges();
      },
    });
  }

  viewValidatedSchema(): void {
    this.router.navigate(['/schema', this.selectedDatabase], { queryParams: { mode: 'validated' } });
  }

  generateAiSchema(): void {
    this.router.navigate(['/schema', this.selectedDatabase], { queryParams: { mode: 'generate' } });
  }

  toggleUploadSection(): void {
    this.showUploadSection = !this.showUploadSection;
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files) {
      const newFiles = Array.from(input.files);
      const existingNames = new Set(this.selectedFiles.map((f) => f.name));
      const filesToAdd = newFiles.filter((f) => !existingNames.has(f.name));
      this.selectedFiles = [...this.selectedFiles, ...filesToAdd];
      input.value = '';
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
        // Base fraîchement créée : rien à voir/générer, on ouvre direct l'upload
        this.databaseStatus = { hasValidatedSchema: false, hasStagingTables: false };
        this.showUploadSection = true;
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
    const database = this.selectedDatabase?.trim();
    if (!database || this.selectedFiles.length === 0) {
      this.errorMessage = 'Sélectionne une base de données et au moins un fichier.';
      this.cdr.detectChanges();
      return;
    }

    this.isUploading = true;
    this.errorMessage = '';
    this.uploadResult = null;
    this.cdr.detectChanges();

     this.uploadService.uploadFiles(database, this.selectedFiles).subscribe({
    next: (result) => {
      this.uploadResult = result;
      const successCount = result.files.filter((f) => f.success).length;
      const failCount = result.files.length - successCount;
      if (failCount === 0) {
        this.toastService.show(`${successCount} fichier(s) importé(s) avec succès.`, 'success');
      } else {
        this.toastService.show(`${successCount} réussi(s), ${failCount} échoué(s).`, 'danger');
      }
    },
    error: (err) => {
      this.errorMessage = "Erreur lors de l'upload : " + (err.error?.message ?? err.message);
      this.toastService.show("Erreur lors de l'upload.", 'danger');
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
    this.router.navigate(['/schema', this.selectedDatabase], { queryParams: { mode: 'generate' } });
  }
}