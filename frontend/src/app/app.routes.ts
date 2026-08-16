import { Routes } from '@angular/router';
import { UploadPageComponent } from './features/upload/upload-page/upload-page';
import { SchemaPage } from './features/schema/schema-page/schema-page';

export const routes: Routes = [
  { path: '', redirectTo: 'upload', pathMatch: 'full' },
  { path: 'upload', component: UploadPageComponent },
  { path: 'schema/:database', component: SchemaPage },
];