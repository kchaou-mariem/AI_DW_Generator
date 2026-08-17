import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AiService } from '../../../core/services/ai.service';
import { AiSchemaProposal } from '../../../core/models/schema.model';

interface ChatMessage {
  role: 'user' | 'ai';
  text: string;
  stepNumber?: number;
}

@Component({
  selector: 'app-chat-page',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat-page.html',
  styleUrl: './chat-page.scss',
})
export class ChatPageComponent implements OnInit {
  database = '';
  sessionId = 0;

  currentSchema: AiSchemaProposal | null = null;
  messages: ChatMessage[] = [];
  userInput = '';

  isSending = false;
  isLoadingHistory = false;
  errorMessage = '';

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private aiService: AiService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.database = this.route.snapshot.paramMap.get('database') ?? '';
    this.sessionId = Number(this.route.snapshot.paramMap.get('sessionId'));

    if (!this.database || !this.sessionId) {
      this.errorMessage = 'Session invalide.';
      return;
    }

    this.loadHistory();
  }

  loadHistory(): void {
    this.isLoadingHistory = true;
    this.cdr.detectChanges();

    this.aiService.getHistory(this.database, this.sessionId).subscribe({
      next: (history) => {
        this.messages = [];
        for (const step of history) {
          if (step.userMessage) {
            this.messages.push({ role: 'user', text: step.userMessage, stepNumber: step.stepNumber });
          }
          this.messages.push({ role: 'ai', text: step.aiExplanation, stepNumber: step.stepNumber });
        }
        if (history.length > 0) {
          this.currentSchema = history[history.length - 1].schema;
        }
      },
      error: (err) => {
        this.errorMessage = "Erreur lors du chargement de l'historique : " + (err.error?.message ?? err.message);
      },
      complete: () => {
        this.isLoadingHistory = false;
        this.cdr.detectChanges();
      },
    });
  }

  sendMessage(): void {
    const text = this.userInput.trim();
    if (!text || this.isSending) return;

    this.messages.push({ role: 'user', text });
    this.userInput = '';
    this.isSending = true;
    this.cdr.detectChanges();

    this.aiService.sendChatMessage(this.database, this.sessionId, text).subscribe({
      next: (response) => {
        this.messages.push({ role: 'ai', text: response.explanation, stepNumber: response.stepNumber });
        this.currentSchema = response.schema;
      },
      error: (err) => {
        this.errorMessage = "Erreur lors de l'envoi du message : " + (err.error?.message ?? err.message);
        this.isSending = false;
        this.cdr.detectChanges();
      },
      complete: () => {
        this.isSending = false;
        this.cdr.detectChanges();
      },
    });
  }

  revertToStep(stepNumber: number): void {
    this.aiService.revertToStep(this.database, this.sessionId, stepNumber).subscribe({
      next: (response) => {
        this.currentSchema = response.schema;
        this.messages.push({
          role: 'ai',
          text: `↩️ Retour à l'étape ${stepNumber}`,
          stepNumber: response.stepNumber,
        });
      },
      error: (err) => {
        this.errorMessage = 'Erreur lors du retour arrière : ' + (err.error?.message ?? err.message);
      },
      complete: () => this.cdr.detectChanges(),
    });
  }

  validateSchema(): void {
    if (!this.currentSchema) return;

    this.aiService.validateSchema(this.database, this.currentSchema).subscribe({
      next: () => {
        this.errorMessage = '';
        alert('Schéma validé et enregistré avec succès !');
      },
      error: (err) => {
        this.errorMessage = 'Erreur lors de la validation : ' + (err.error?.message ?? err.message);
        this.cdr.detectChanges();
      },
    });
  }

  backToSchema(): void {
    this.router.navigate(['/schema', this.database]);
  }
}