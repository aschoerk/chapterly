import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { isImageRef } from '../../core/image-ref';

@Component({
  selector: 'app-avatar-view',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './avatar-view.component.html',
  styleUrl: './avatar-view.component.css'
})
export class AvatarViewComponent {
  @Input() value = '';
  @Input() alt = '';
  @Input() fallback = '?';

  isImage(): boolean {
    return isImageRef(this.value);
  }

  isEmoji(): boolean {
    return !!this.value && !isImageRef(this.value);
  }
}
