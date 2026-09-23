import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { I18nService } from '../../core/i18n/i18n.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.css'
})
export class LoginComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  readonly i18n = inject(I18nService);

  username = '';
  password = '';
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly googleEnabled = signal(false);

  async ngOnInit(): Promise<void> {
  }

  google(): void {
  }

  private async finishGoogle(code: string): Promise<void> {
    this.error.set(null);
    this.busy.set(true);
    try {
      await this.router.navigateByUrl('/chat');
    } catch (err: unknown) {
      const http = err as { error?: { error?: string }; status?: number };
      this.error.set(http?.error?.error || this.i18n.t('login.failed'));
    } finally {
      this.busy.set(false);
    }
  }

  async submit(): Promise<void> {
    this.error.set(null);
    this.busy.set(true);
    try {
      await this.router.navigateByUrl('/chat');
    } catch (err: unknown) {
      const http = err as { error?: { error?: string }; status?: number };
      this.error.set(http?.error?.error || (http?.status === 401 ? this.i18n.t('login.invalid') : this.i18n.t('login.failed')));
    } finally {
      this.busy.set(false);
    }
  }

  skip(): void {
    void this.router.navigateByUrl('/chat');
  }
}
