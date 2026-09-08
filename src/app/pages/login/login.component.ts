import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { I18nService } from '../../core/i18n/i18n.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.css'
})
export class LoginComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  readonly i18n = inject(I18nService);

  username = '';
  password = '';
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  ngOnInit(): void {
    // When started as Electron app there is no login — bounce straight to chat.
    if (this.auth.electron) {
      void this.router.navigateByUrl('/chat');
    }
  }

  async submit(): Promise<void> {
    this.error.set(null);
    this.busy.set(true);
    try {
      await this.auth.login(this.username.trim(), this.password);
      await this.router.navigateByUrl('/chat');
    } catch (err: unknown) {
      const http = err as { error?: { error?: string }; status?: number };
      this.error.set(http?.error?.error || (http?.status === 401 ? this.i18n.t('login.invalid') : this.i18n.t('login.failed')));
    } finally {
      this.busy.set(false);
    }
  }

  skip(): void {
    this.auth.continueWithoutToken();
    void this.router.navigateByUrl('/chat');
  }
}
