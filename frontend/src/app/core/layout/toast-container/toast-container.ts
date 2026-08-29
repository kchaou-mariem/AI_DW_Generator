import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ToastService } from '../../services/toast.service';

@Component({
  selector: 'app-toast-container',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './toast-container.html',
})
export class ToastContainerComponent {
  constructor(public toastService: ToastService) {}

  iconFor(type: string): string {
    if (type === 'success') return 'bi-check-circle-fill';
    if (type === 'danger') return 'bi-x-circle-fill';
    return 'bi-info-circle-fill';
  }
}