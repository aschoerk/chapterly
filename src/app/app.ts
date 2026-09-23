import { Component, inject, signal } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import {AppNavComponent} from './components/app-nav/app-nav.component';
import {ConfirmDialogComponent} from './components/confirm-dialog/confirm-dialog.component';
import { ThemeService } from './core/theme.service';
import { EnvironmentService } from './core/environment.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, AppNavComponent, ConfirmDialogComponent],
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  protected readonly title = signal('chat');
  private readonly theme = inject(ThemeService);
  private readonly environment = inject(EnvironmentService);
  readonly router = inject(Router);

  constructor() {

  }

  showNav(): boolean {
    return true;
  }
}
