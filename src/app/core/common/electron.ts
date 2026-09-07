export interface ElectronAPI {
  isElectron?: boolean;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

/**
 * Detects whether the app is running inside the Electron shell
 * (electron/preload.js exposes window.electronAPI).
 */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI;
}