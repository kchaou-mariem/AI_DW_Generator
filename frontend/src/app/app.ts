import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { HeaderComponent } from './core/layout/header/header';
import { ToastContainerComponent } from './core/layout/toast-container/toast-container';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, HeaderComponent, ToastContainerComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  protected readonly title = signal('dw-frontend');
}