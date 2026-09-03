import { Injectable, signal, computed, inject } from '@angular/core';
import { Persona } from '../models/chat';
import { CHAT_API } from '../api/chat-api.token';
import {
  CreatePersonaRequest,
  UpdatePersonaRequest,
} from '../api/chat-api.types';
import { getServerConfig } from './server-config';
import { firstValueFrom } from "rxjs";
import {NodeEditSession} from './node-edit-session';

const LS_CHAT  = 'chat.currentChatId';
const LS_SCROLL = 'chat.scrollByChatId';

@Injectable({
  providedIn: 'root'
})
export class PersonaService {
  private readonly api = inject(CHAT_API);
  private readonly _personas = signal<Persona[]>([]);
  private readonly CURRENT_PERSONA_KEY = 'chat-client.currentPersonaId';
  private readonly _currentPersonaId = signal<string | null>(null);

  readonly personas = computed(() => this._personas());
  readonly currentPersonaId = computed(() => this._currentPersonaId());
  readonly currentPersona = computed(() => this.getPersona(this._currentPersonaId()));

  constructor() {
    this.loadCurrentPersonaId();   // ← critical line
  }

  // ---------- Personas ----------

  async loadPersonas(): Promise<void> {
    this._personas.set(await this.api.getPersonas());
  }

  async createPersona(data: CreatePersonaRequest): Promise<Persona> {
    const persona = await this.api.createPersona(data);
    this._personas.update(list =>
      [...list, persona].sort((a, b) => a.name.localeCompare(b.name))
    );
    return persona;
  }

  async updatePersona(id: string, data: UpdatePersonaRequest): Promise<Persona> {
    const persona = await this.api.updatePersona(id, data);
    this._personas.update(list =>
      list
        .map(p => (p.id === id ? persona : p))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
    return persona;
  }

  async deletePersona(id: string): Promise<void> {
    await this.api.deletePersona(id);
    this._personas.update(list => list.filter(p => p.id !== id));

    if (this._currentPersonaId() === id) {
      this.setCurrentPersona(null);
    }
  }

  getPersona(id: string | null | undefined): Persona | undefined {
    if (!id) return undefined;
    return this._personas().find(p => p.id === id);
  }

  // Call once (e.g. in constructor or a private init)
  private loadCurrentPersonaId() {
    try {
      const id = localStorage.getItem(this.CURRENT_PERSONA_KEY);
      if (id) {
        this._currentPersonaId.set(id);
      }
    } catch {
      // ignore
    }
  }

  setCurrentPersona(id: string | null): void {
    this._currentPersonaId.set(id);
    try {
      if (id) {
        localStorage.setItem(this.CURRENT_PERSONA_KEY, id);
      } else {
        localStorage.removeItem(this.CURRENT_PERSONA_KEY);
      }
    } catch {
      // ignore
    }
  }




}
