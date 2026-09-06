import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.css'
})
export class LoginComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  username = '';
  password = '';
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  async submit(): Promise<void> {
    this.error.set(null);
    this.busy.set(true);
    try {
      await this.auth.login(this.username.trim(), this.password);
      await this.router.navigateByUrl('/chat');
    } catch (err: unknown) {
      const http = err as { error?: { error?: string }; status?: number };
      this.error.set(http?.error?.error || (http?.status === 401 ? 'Invalid credentials' : 'Login failed'));
    } finally {
      this.busy.set(false);
    }
  }

  skip(): void {
    this.auth.continueWithoutToken();
    void this.router.navigateByUrl('/chat');
  }
}
