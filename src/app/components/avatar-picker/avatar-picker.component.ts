import { Component, EventEmitter, Input, Output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { isImageRef } from '../../core/image-ref';
import { AvatarViewComponent } from '../avatar-view/avatar-view.component';

const PRESET_EMOJIS = [
  '😀', '🧙', '🕵️', '👩‍🚀', '🐉', '🏰',
  '🌌', '⚔️', '📚', '🧪', '🎭', '🖋️',
  '🌙', '🔥', '🌊', '🌲', '🤖', '👻',
  '👑', '🪄', '🪐', '🕯️', '🧭', '📌'
];

@Component({
  selector: 'app-avatar-picker',
  standalone: true,
  imports: [CommonModule, FormsModule, AvatarViewComponent],
  templateUrl: './avatar-picker.component.html',
  styleUrl: './avatar-picker.component.css'
})
export class AvatarPickerComponent {
  @Input() value = '';
  @Input() label = 'Avatar';
  @Input() placeholder = '?';
  @Input() hint = 'Use a photo or an emoji. Images are stored as data URLs (keep under ~800 KB).';
  @Input() error: string | null = null;

  @Output() valueChange = new EventEmitter<string>();
  @Output() errorChange = new EventEmitter<string | null>();

  readonly presets = PRESET_EMOJIS;
  readonly showPalette = signal(false);

  isImage(): boolean {
    return isImageRef(this.value);
  }

  emojiDraft(): string {
    return this.isImage() ? '' : this.value;
  }

  togglePalette(): void {
    this.showPalette.update(open => !open);
  }

  pickEmoji(emoji: string): void {
    this.valueChange.emit(emoji);
    this.errorChange.emit(null);
    this.showPalette.set(false);
  }

  onEmojiTyped(raw: string): void {
    const next = raw.trim();
    this.valueChange.emit(next);
    this.errorChange.emit(null);
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      this.errorChange.emit('Please select an image file');
      return;
    }
    if (file.size > 800_000) {
      this.errorChange.emit('Image is too large (max ~800 KB). Please choose a smaller one.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      this.valueChange.emit(reader.result as string);
      this.errorChange.emit(null);
      this.showPalette.set(false);
    };
    reader.onerror = () => this.errorChange.emit('Failed to read image');
    reader.readAsDataURL(file);
  }

  clear(): void {
    this.valueChange.emit('');
    this.errorChange.emit(null);
    this.showPalette.set(false);
  }
}
