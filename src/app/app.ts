import { Component, inject, signal } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import {AppNavComponent} from './components/app-nav/app-nav.component';
import {ConfirmDialogComponent} from './components/confirm-dialog/confirm-dialog.component';
import {IllustrateDialogComponent} from './components/illustrate-dialog/illustrate-dialog.component';
import {PrependDialogComponent} from './components/prepend-dialog/prepend-dialog.component';
import {RewriteDialogComponent} from './components/rewrite-dialog/rewrite-dialog.component';
import {CreateImageDialogComponent} from './components/create-image-dialog/create-image-dialog.component';
import {ChapterDescriptionsDialogComponent} from './components/chapter-descriptions-dialog/chapter-descriptions-dialog.component';
import {ImageLightboxComponent} from './components/image-lightbox/image-lightbox.component';
import { ThemeService } from './core/theme.service';
import { EnvironmentService } from './core/environment.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, AppNavComponent, ConfirmDialogComponent, IllustrateDialogComponent, PrependDialogComponent, RewriteDialogComponent, CreateImageDialogComponent, ChapterDescriptionsDialogComponent, ImageLightboxComponent],
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
