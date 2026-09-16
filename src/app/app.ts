import { Component, inject, signal } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import {AppNavComponent} from './components/app-nav/app-nav.component';
import { ThemeService } from './core/theme.service';
import { EnvironmentService } from './core/environment.service';
import { AuthService } from './core/auth.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, AppNavComponent],
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  protected readonly title = signal('chat');
  private readonly theme = inject(ThemeService);
  private readonly environment = inject(EnvironmentService);
  readonly auth = inject(AuthService);
  readonly router = inject(Router);

  constructor() {
    void this.auth.syncFromEnvironment().then(() => {
      if (!this.auth.isLoggedIn() && !this.router.url.startsWith('/login')) {
        void this.router.navigateByUrl('/login');
      }
    });
  }

  showNav(): boolean {
    return this.auth.ready() && this.auth.isLoggedIn() && !this.router.url.startsWith('/login');
  }
}
