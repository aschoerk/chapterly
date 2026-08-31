import { Component, inject, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import {ConfirmDialogComponent} from './components/confirm-dialog/confirm-dialog.component';
import {AppNavComponent} from './components/app-nav/app-nav.component';
import { ThemeService } from './core/theme.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ConfirmDialogComponent, AppNavComponent],
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  protected readonly title = signal('chat');
  private readonly theme = inject(ThemeService);
}
