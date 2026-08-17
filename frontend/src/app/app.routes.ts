import { Routes } from '@angular/router';
import { UploadPageComponent } from './features/upload/upload-page/upload-page';
import { SchemaPageComponent } from './features/schema/schema-page/schema-page';
import { ChatPageComponent } from './features/chat/chat-page/chat-page';

export const routes: Routes = [
  { path: '', redirectTo: 'upload', pathMatch: 'full' },
  { path: 'upload', component: UploadPageComponent },
  { path: 'schema/:database', component: SchemaPageComponent },
  { path: 'chat/:database/:sessionId', component: ChatPageComponent },
];