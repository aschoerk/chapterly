import { Component, inject, signal, OnInit, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ChatService } from '../../core/chat.service';
import { Persona } from '../../models/chat';

@Component({
  selector: 'app-personas',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './personas.component.html',
  styleUrl: './personas.component.css'
})
export class PersonasComponent implements OnInit {
  private readonly chatService = inject(ChatService);
  private readonly router = inject(Router);

  readonly personas = this.chatService.personas;

  readonly searchTerm = signal('');
  readonly showForm = signal(false);
  readonly editingId = signal<string | null>(null);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly openMenuId = signal<string | null>(null);

  // Form model
  form = {
    name: '',
    shortName: '',
    description: '',
    avatar: ''
  };

  readonly filteredPersonas = computed(() => {
    const term = this.searchTerm().toLowerCase().trim();
    const list = this.personas();
    if (!term) return list;
    return list.filter(
      p =>
        p.name.toLowerCase().includes(term) ||
        p.shortName.toLowerCase().includes(term) ||
        (p.description || '').toLowerCase().includes(term)
    );
  });

  async ngOnInit() {
    try {
      await this.chatService.loadPersonas();
    } catch (e) {
      console.error('Failed to load personas', e);
      this.error.set('Failed to load personas from server.');
    }
  }

  goToChat() {
    this.router.navigate(['/chat']);
  }

  openCreate() {
    this.editingId.set(null);
    this.form = {
      name: '',
      shortName: '',
      description: '',
      avatar: ''
    };
    this.error.set(null);
    this.showForm.set(true);
  }

  openEdit(persona: Persona) {
    this.editingId.set(persona.id);
    this.form = {
      name: persona.name,
      shortName: persona.shortName,
      description: persona.description || '',
      avatar: persona.avatar || ''
    };
    this.error.set(null);
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
    this.editingId.set(null);
    this.error.set(null);
  }

  async save() {
    const name = this.form.name.trim();
    const shortName = this.form.shortName.trim();

    if (!name) {
      this.error.set('Name is required');
      return;
    }
    if (!shortName) {
      this.error.set('Short name is required');
      return;
    }

    this.saving.set(true);
    this.error.set(null);

    try {
      if (this.editingId()) {
        await this.chatService.updatePersona(this.editingId()!, {
          name,
          shortName,
          description: this.form.description,
          avatar: this.form.avatar
        });
      } else {
        await this.chatService.createPersona({
          name,
          shortName,
          description: this.form.description,
          avatar: this.form.avatar
        });
      }
      this.closeForm();
    } catch (e: any) {
      console.error(e);
      this.error.set(e?.error?.error || e?.message || 'Save failed');
    } finally {
      this.saving.set(false);
    }
  }

  async deletePersona(persona: Persona) {
    if (!confirm(`Delete persona "${persona.name}"? This cannot be undone.`)) {
      return;
    }
    try {
      await this.chatService.deletePersona(persona.id);
    } catch (e) {
      console.error(e);
      alert('Failed to delete persona');
    }
  }

  onAvatarSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      this.error.set('Please select an image file');
      return;
    }

    // Limit size roughly (data URLs get large)
    if (file.size > 800_000) {
      this.error.set('Image is too large (max ~800 KB). Please choose a smaller one.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      this.form.avatar = reader.result as string;
      this.error.set(null);
    };
    reader.onerror = () => {
      this.error.set('Failed to read image');
    };
    reader.readAsDataURL(file);
  }

  clearAvatar() {
    this.form.avatar = '';
  }

  toggleMenu(id: string, event: Event) {
    event.stopPropagation();
    this.openMenuId.update(current => (current === id ? null : id));
  }

  closeMenu() {
    this.openMenuId.set(null);
  }

  trackById(_: number, p: Persona) {
    return p.id;
  }

  isCurrent(persona: Persona): boolean {
    return this.chatService.currentPersonaId() === persona.id;
  }

  setAsCurrent(persona: Persona): void {
    this.chatService.setCurrentPersona(persona.id);
    this.closeMenu();
  }

  clearCurrent(): void {
    this.chatService.setCurrentPersona(null);
  }
}
