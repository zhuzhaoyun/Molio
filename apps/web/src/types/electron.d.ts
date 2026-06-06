/**
 * Electron preload API type declarations.
 */

declare global {
  interface Window {
    __electron__?: {
      platform: string;
      showDirectoryPicker: () => Promise<string | null>;
    };
  }
}

export {};
