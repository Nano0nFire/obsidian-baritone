export interface VaultFileInfo { path: string; mtime: number; size: number }

export interface VaultIO {
  listFiles(): VaultFileInfo[];
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  writeText(path: string, text: string): Promise<void>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  trash(path: string, system: boolean): Promise<void>;
  exists(path: string): boolean;
}
