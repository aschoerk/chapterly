import { Component, HostListener, inject } from '@angular/core';
import { LightboxService } from '../../core/lightbox.service';
import { I18nService } from '../../core/i18n/i18n.service';

@Component({
  selector: 'app-image-lightbox',
  standalone: true,
  templateUrl: './image-lightbox.component.html',
  styleUrl: './image-lightbox.component.css'
})
export class ImageLightboxComponent {
  readonly lightbox = inject(LightboxService);
  readonly i18n = inject(I18nService);

  onBackdrop(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.lightbox.close();
  }

  @HostListener('document:keydown', ['$event'])
  onKey(ev: KeyboardEvent): void {
    if (!this.lightbox.current()) return;
    if (ev.key === 'Escape') this.lightbox.close();
    else if (ev.key === 'ArrowRight') this.lightbox.next();
    else if (ev.key === 'ArrowLeft') this.lightbox.prev();
  }
}