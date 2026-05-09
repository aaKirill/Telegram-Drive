// Stub for node-localstorage. Pulled into the gramjs bundle by StoreSession,
// which we don't use (StringSession only). Aliased away in vite.config.web.ts
// so the real package — which references Node fs/path — never gets bundled.

export class LocalStorage {
  constructor(_path: string, _quota?: number) {}
  getItem(_key: string): string | null { return null; }
  setItem(_key: string, _value: string): void {}
  removeItem(_key: string): void {}
  clear(): void {}
  key(_index: number): string | null { return null; }
  get length(): number { return 0; }
}

export default LocalStorage;
