import { Component, EventEmitter, Input, Output, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { isImageRef } from '../../core/image-ref';
import { AvatarViewComponent } from '../avatar-view/avatar-view.component';

export interface EmojiBlock {
  name: string;
  emojis: string[];
}

const EMOJI_BLOCKS: EmojiBlock[] = [
  {
    name: 'Originals & Archetypes',
    emojis: ['😀', '🧙', '🕵️', '👩‍🚀', '🐉', '🏰', '🌌', '⚔️', '📚', '🧪', '🎭', '🖋️', '🌙', '🔥', '🌊', '🌲', '🤖', '👻', '👑', '🪄', '🪐', '🕯️', '🧭', '📌']
  },
  {
    name: 'Fantasy & Mythical',
    emojis: ['🧜‍♀️', '🧛‍♂️', '🧝‍♂️', '🧚', '🦸‍♀️', '🦹‍♂️', '🧟‍♂️', '🗿', '🦄', '👺', '👾', '🥷', '👽', '💀', '🧞‍♂️', '🗡️', '🛡️', '🔱', '🏴‍☠️', '🧿', '🔮', '📿', '📜', '⚖️']
  },
  {
    name: 'Animals & Beasts',
    emojis: ['🦅', '🐺', '🦊', '🦁', '🦉', '🐍', '🦇', '🦂', '🕷️', '🐙', '🦈', '🐅', '🐆', '🐻', '🐼', '🐨', '🐗', '🐴', '🐝', '🦋', '🐞', '🐢', '🦩', '🦚']
  },
  {
    name: 'Professions & Roles',
    emojis: ['👨‍🍳', '👩‍🎨', '👨‍🎤', '👩‍⚕️', '👨‍🏫', '👩‍🌾', '👷‍♂️', '👩‍💻', '👨‍💼', '👩‍🔧', '👨‍🔬', '👩‍⚖️', '👨‍✈️', '👩‍🚒', '👮‍♂️', '💂‍♀️', '🧘‍♀️', '🏋️‍♂️', '🚣‍♂️', '🚴‍♀️', '🤿', '🤺', '🏇', '🤹‍♂️']
  },
  {
    name: 'Nature & Elements',
    emojis: ['☀️', '🌤️', '🌩️', '❄️', '🌈', '⚡', '☄️', '💫', '💥', '🌪️', '🌋', '🌊', '🌱', '🌿', '☘️', '🍀', '🎍', '🎋', '🍃', '🍂', '🍁', '🍄', '🌵', '🌾']
  },
  {
    name: 'Tech, Sci-Fi & Space',
    emojis: ['🚀', '🛰️', '🛸', '💻', '🖥️', '📡', '🔋', '💡', '🔦', '⚙️', '🧰', '🔧', '🧬', '🔬', '🔭', '💣', '📻', '📺', '📽️', '📷', '🎮', '🕹️', '💾', '📱']
  },
  {
    name: 'Games, Arts & Hobbies',
    emojis: ['🎨', '🎬', '🎤', '🎧', '🎼', '🎹', '🥁', '🎷', '🎺', '🎸', '🪕', '🎻', '🎲', '♟️', '🎯', '🎳', '🧩', '🎰', '🪁', '🃏', '🀄', '🪀', '🖌️', '🎨']
  },
  {
    name: 'Places, Buildings & Travel',
    emojis: ['⛩️', '🕋', '🏛️', '⛪', '🕌', '🕍', '🏯', '🗼', '🗽', '⛺', '🛕', '🏎️', '🏍️', '🚂', '✈️', '⛵', '🚁', '🎡', '🎢', '🏠', '🌆', '🏝️', '🌄', '🌉']
  },
  {
    name: 'Food & Celebrations',
    emojis: ['☕', '🍵', '🧋', '🍺', '🍷', '🍸', '🍰', '🎂', '🍩', '🍪', '🍫', '🍬', '🍕', '🍔', '🍟', '🌭', '🌮', '🍿', '🎉', '🎊', '🎈', '🎁', '🎀', '🎏']
  },
  {
    name: 'Objects & Symbols',
    emojis: ['🗝️', '🔑', '🔒', '💎', '🏺', '⌛', '⏰', '🪞', '🧸', '🔔', '🏮', '💍', '❤️', '🖤', '✨', '🏷️', '📦', '🧲', '⏳', '🔱', '🧿', '🏷️', '📜', '🔏']
  }
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

  readonly blocks = EMOJI_BLOCKS;
  readonly showPalette = signal(false);
  readonly blockIndex = signal(0);

  readonly currentBlock = computed(() => this.blocks[this.blockIndex()]);
  readonly blockLabel = computed(
    () => `${this.blockIndex() + 1} / ${this.blocks.length}`
  );

  isImage(): boolean {
    return isImageRef(this.value);
  }

  emojiDraft(): string {
    return this.isImage() ? '' : this.value;
  }

  togglePalette(): void {
    const opening = !this.showPalette();
    this.showPalette.set(opening);
    if (opening) {
      this.blockIndex.set(this.blockIndexForValue(this.value));
    }
  }

  prevBlock(): void {
    const n = this.blocks.length;
    this.blockIndex.update(i => (i - 1 + n) % n);
  }

  nextBlock(): void {
    const n = this.blocks.length;
    this.blockIndex.update(i => (i + 1) % n);
  }

  pickEmoji(emoji: string): void {
    this.valueChange.emit(emoji);
    this.errorChange.emit(null);
  }

  onEmojiTyped(raw: string): void {
    const next = raw.trim();
    this.valueChange.emit(next);
    this.errorChange.emit(null);
    this.blockIndex.set(this.blockIndexForValue(next));
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

  private blockIndexForValue(value: string): number {
    if (!value || isImageRef(value)) return 0;
    const found = this.blocks.findIndex(block => block.emojis.includes(value));
    return found >= 0 ? found : this.blockIndex();
  }
}
