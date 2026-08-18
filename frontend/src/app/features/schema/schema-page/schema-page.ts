import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AiService } from '../../../core/services/ai.service';
import { AiSchemaProposal } from '../../../core/models/schema.model';

interface DiagramBox {
  id: string;
  label: string;
  type: 'fact' | 'dimension' | 'subdimension' | 'time';
  x: number;
  y: number;
  width: number;
  height: number;
  attributes: string[];
}

interface DiagramLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  kind: 'fact-dim' | 'dim-subdim';
}

interface ChatMessage {
  role: 'user' | 'ai';
  text: string;
  stepNumber?: number;
}

interface SchemaState {
  stepNumber: number;
  schema: AiSchemaProposal;
  label: string;
}

@Component({
  selector: 'app-schema-page',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './schema-page.html',
  styleUrl: './schema-page.scss',
})
export class SchemaPageComponent implements OnInit {
  database = '';
  sessionId = 0;
  schema: AiSchemaProposal | null = null;
  mode: 'generate' | 'validated' = 'generate';

  diagramBoxes: DiagramBox[] = [];
  diagramLines: DiagramLine[] = [];
  diagramWidth = 1000;
  diagramHeight = 600;
  summaryText = '';

  // ---- Nouveau : panneau d'états ----
  states: SchemaState[] = [];
  currentStepNumber = 0;
  validatedStepNumber: number | null = null;
  validatingStepNumber: number | null = null;

  messages: ChatMessage[] = [];
  userInput = '';
  isSending = false;

  isGenerating = false;
  errorMessage = '';

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private aiService: AiService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.database = this.route.snapshot.paramMap.get('database') ?? '';
    this.mode = (this.route.snapshot.queryParamMap.get('mode') as 'generate' | 'validated') ?? 'generate';

    if (!this.database) {
      this.errorMessage = 'Aucune base de données spécifiée.';
      return;
    }

    if (this.mode === 'validated') {
      this.loadValidatedSchema();
    } else {
      this.generateAndStartSession();
    }
  }

  generateAndStartSession(): void {
    this.isGenerating = true;
    this.errorMessage = '';
    this.schema = null;
    this.messages = [];
    this.states = [];
    this.cdr.detectChanges();

    this.aiService.generateSchema(this.database).subscribe({
      next: (result) => {
        this.schema = result;
        this.buildDiagram(result);
        this.aiService.startSessionFromExisting(this.database, result).subscribe({
          next: (session) => {
            this.sessionId = session.sessionId;
            this.isGenerating = false;
            this.refreshHistory();
            this.cdr.detectChanges();
          },
          error: (err) => {
            this.errorMessage = 'Erreur démarrage session : ' + (err.error?.message ?? err.message);
            this.isGenerating = false;
            this.cdr.detectChanges();
          },
        });
      },
      error: (err) => {
        this.errorMessage = 'Erreur génération schéma : ' + (err.error?.message ?? err.message);
        this.isGenerating = false;
        this.cdr.detectChanges();
      },
    });
  }

  // ---- Nouveau : charge directement le dernier schéma validé ----
  loadValidatedSchema(): void {
    this.isGenerating = true;
    this.errorMessage = '';
    this.schema = null;
    this.messages = [];
    this.states = [];
    this.cdr.detectChanges();

    this.aiService.getValidatedSchema(this.database).subscribe({
      next: ({ schema }) => {
        this.schema = schema;
        this.buildDiagram(schema);
        this.aiService.startSessionFromExisting(this.database, schema).subscribe({
          next: (session) => {
            this.sessionId = session.sessionId;
            this.isGenerating = false;
            this.refreshHistory();
            this.cdr.detectChanges();
          },
          error: (err) => {
            this.errorMessage = 'Erreur démarrage session : ' + (err.error?.message ?? err.message);
            this.isGenerating = false;
            this.cdr.detectChanges();
          },
        });
      },
      error: (err) => {
        this.errorMessage = 'Aucun schéma validé trouvé pour cette base : ' + (err.error?.message ?? err.message);
        this.isGenerating = false;
        this.cdr.detectChanges();
      },
    });
  }

  // ---- Nouveau : recharge l'historique complet pour le panneau d'états ----
  refreshHistory(): void {
    if (!this.sessionId) return;
    this.aiService.getHistory(this.database, this.sessionId).subscribe({
      next: (history) => {
        this.states = history.map((h) => ({
          stepNumber: h.stepNumber,
          schema: h.schema,
          label: `État ${h.stepNumber}`,
        }));
        this.currentStepNumber =
          this.states.length > 0 ? this.states[this.states.length - 1].stepNumber : 0;
        this.cdr.detectChanges();
      },
      error: () => {
        // Le panneau d'états n'est pas bloquant, on ignore silencieusement
      },
    });
  }

sendMessage(): void {
  const text = this.userInput.trim();
  if (!text || this.isSending || !this.sessionId || !this.schema) return;

  this.messages.push({ role: 'user', text });
  this.userInput = '';
  this.isSending = true;
  this.cdr.detectChanges();

  this.aiService.sendChatMessage(this.database, this.sessionId, text, this.schema).subscribe({
    next: (response) => {
      this.messages.push({ role: 'ai', text: response.explanation, stepNumber: response.stepNumber });
      this.schema = response.schema;
      this.currentStepNumber = response.stepNumber;
      this.buildDiagram(response.schema);
      this.refreshHistory();
    },
    error: (err) => {
      this.errorMessage = 'Erreur : ' + (err.error?.message ?? err.message);
      this.isSending = false;
      this.cdr.detectChanges();
    },
    complete: () => {
      this.isSending = false;
      this.cdr.detectChanges();
    },
  });
}

  // // ---- Appelé par le panneau d'états (clic sur "État X") ----
  // revertToStep(stepNumber: number): void {
  //   if (!this.sessionId) return;

  //   this.aiService.revertToStep(this.database, this.sessionId, stepNumber).subscribe({
  //     next: (response) => {
  //       this.schema = response.schema;
  //       this.currentStepNumber = response.stepNumber;
  //       this.buildDiagram(response.schema);
  //       this.refreshHistory();
  //     },
  //     error: (err) => {
  //       this.errorMessage = 'Erreur retour arrière : ' + (err.error?.message ?? err.message);
  //       this.cdr.detectChanges();
  //     },
  //     complete: () => this.cdr.detectChanges(),
  //   });
  // }

  // Consultation LOCALE d'un état passé : aucun appel réseau, aucun nouveau step créé
viewState(state: SchemaState): void {
  this.schema = state.schema;
  this.currentStepNumber = state.stepNumber;
  this.buildDiagram(state.schema);
  this.cdr.detectChanges();
}

  // ---- Valider l'état actuellement affiché ----
  validateSchema(): void {
    if (!this.schema) return;
    this.aiService.validateSchema(this.database, this.schema).subscribe({
      next: () => {
        this.validatedStepNumber = this.currentStepNumber;
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.errorMessage = 'Erreur validation : ' + (err.error?.message ?? err.message);
        this.cdr.detectChanges();
      },
    });
  }

  // ---- Nouveau : valider un état précis depuis le panneau, sans y naviguer d'abord ----
  validateState(state: SchemaState): void {
    this.validatingStepNumber = state.stepNumber;
    this.cdr.detectChanges();

    this.aiService.validateSchema(this.database, state.schema).subscribe({
      next: () => {
        this.validatedStepNumber = state.stepNumber;
        this.validatingStepNumber = null;
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.errorMessage = 'Erreur validation : ' + (err.error?.message ?? err.message);
        this.validatingStepNumber = null;
        this.cdr.detectChanges();
      },
    });
  }

  backToUpload(): void {
    this.router.navigate(['/upload']);
  }

  private buildDiagram(schema: AiSchemaProposal): void {
  const boxWidth = 170;
  const headerHeight = 30;
  const rowHeight = 18;
  const maxAttrsShown = 3;
  const laneGapY = 30;

  const lanes = {
    subLeft: 20,
    dimLeft: 260,
    fact: 560,
    dimRight: 860,
    subRight: 1100,
  };
  const laneY: Record<string, number> = {
    subLeft: 40,
    dimLeft: 40,
    fact: 40,
    dimRight: 40,
    subRight: 40,
  };

  const boxes: DiagramBox[] = [];
  const positions = new Map<string, DiagramBox>();

  const makeBox = (name: string, type: DiagramBox['type'], laneKey: keyof typeof lanes): DiagramBox => {
    const attrs = (schema.tableAttributes[name] ?? []).map((a) => a.name);
    const shown = attrs.slice(0, maxAttrsShown);
    const extra = attrs.length - shown.length;
    const height = headerHeight + shown.length * rowHeight + (extra > 0 ? rowHeight : 0) + 10;

    const box: DiagramBox = {
      id: name,
      label: name,
      type,
      x: lanes[laneKey],
      y: laneY[laneKey],
      width: boxWidth,
      height,
      attributes: extra > 0 ? [...shown, `+${extra} autres`] : shown,
    };
    laneY[laneKey] += height + laneGapY;

    boxes.push(box);
    positions.set(name, box);
    return box;
  };

  const dims = schema.dimensions.filter((d) => !d.toLowerCase().includes('dimtemps'));
  const timeDims = schema.dimensions.filter((d) => d.toLowerCase().includes('dimtemps'));
  const facts = schema.facts;
  const subDims = schema.subDimensions;

  facts.forEach((f) => makeBox(f, 'fact', 'fact'));
  timeDims.forEach((d) => makeBox(d, 'time', 'fact'));

  const dimLaneOf = new Map<string, 'dimLeft' | 'dimRight'>();
  dims.forEach((d, i) => {
    const lane: 'dimLeft' | 'dimRight' = i % 2 === 0 ? 'dimLeft' : 'dimRight';
    dimLaneOf.set(d, lane);
    makeBox(d, 'dimension', lane);
  });

  subDims.forEach((sd) => {
    const parentLane = dimLaneOf.get(sd.parentDimension);
    const subLane: keyof typeof lanes = parentLane === 'dimRight' ? 'subRight' : 'subLeft';
    makeBox(sd.name, 'subdimension', subLane);
  });

  this.diagramBoxes = boxes;

  const factSet = new Set(schema.facts);
  const lines: DiagramLine[] = [];

  for (const rel of schema.confirmedRelations) {
    const a = positions.get(rel.tableA);
    const b = positions.get(rel.tableB);
    if (!a || !b) continue;

    const factIsA = factSet.has(rel.tableA);
    const from = factIsA ? a : b;
    const to = factIsA ? b : a;

    const fromCenter = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
    const toCenter = { x: to.x + to.width / 2, y: to.y + to.height / 2 };

    const start = this.getEdgePoint(from, toCenter);
    const end = this.getEdgePoint(to, fromCenter);

    lines.push({ x1: start.x, y1: start.y, x2: end.x, y2: end.y, kind: 'fact-dim' });
  }

  for (const sd of schema.subDimensions) {
    const parent = positions.get(sd.parentDimension);
    const child = positions.get(sd.name);
    if (!parent || !child) continue;

    const parentCenter = { x: parent.x + parent.width / 2, y: parent.y + parent.height / 2 };
    const childCenter = { x: child.x + child.width / 2, y: child.y + child.height / 2 };

    const start = this.getEdgePoint(parent, childCenter);
    const end = this.getEdgePoint(child, parentCenter);

    lines.push({ x1: start.x, y1: start.y, x2: end.x, y2: end.y, kind: 'dim-subdim' });
  }

  this.diagramLines = lines;

  const maxX = Math.max(...boxes.map((b) => b.x + b.width), 1000) + 40;
  const maxY = Math.max(...boxes.map((b) => b.y + b.height), 600) + 40;
  this.diagramWidth = maxX;
  this.diagramHeight = maxY;

  // ✅ NOUVEAU : détection du type de schéma tenant compte des sous-dimensions
  const relCount = schema.confirmedRelations.length;
  const isSnowflake = subDims.length > 0;
  const isConstellation = facts.length > 1;

  let shape: string;
  if (isConstellation && isSnowflake) {
    shape = 'en constellation avec flocon de neige (plusieurs faits, dimensions normalisées)';
  } else if (isConstellation) {
    shape = 'en constellation (plusieurs faits)';
  } else if (isSnowflake) {
    shape = 'en flocon de neige (dimensions normalisées en sous-dimensions)';
  } else {
    shape = 'en étoile (un seul fait, dimensions non normalisées)';
  }

  this.summaryText =
    `Ce schéma ${shape} contient ${facts.length} table(s) de fait, ${dims.length} dimension(s)` +
    (subDims.length > 0 ? `, ${subDims.length} sous-dimension(s)` : '') +
    ` et ${relCount} relation(s) confirmée(s).`;
}
  private getEdgePoint(box: DiagramBox, towards: { x: number; y: number }): { x: number; y: number } {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const dx = towards.x - cx;
    const dy = towards.y - cy;

    if (dx === 0 && dy === 0) return { x: cx, y: cy };

    const halfW = box.width / 2;
    const halfH = box.height / 2;

    const scaleX = dx !== 0 ? halfW / Math.abs(dx) : Infinity;
    const scaleY = dy !== 0 ? halfH / Math.abs(dy) : Infinity;
    const scale = Math.min(scaleX, scaleY);

    return { x: cx + dx * scale, y: cy + dy * scale };
  }
}