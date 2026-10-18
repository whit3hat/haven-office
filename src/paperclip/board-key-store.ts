/**
 * Encrypted-at-rest storage for the fallback board API key.
 *
 * `ConnectionStore` writes `connections.json` as plaintext JSON under
 * `userData`, so a credential must never go near it — this is a separate file
 * holding nothing but ciphertext, keyed by connection profile so two remotes
 * cannot read each other's key.
 *
 * Encryption is Electron's `safeStorage`, which on macOS is the Keychain. The
 * `SafeStorageLike` seam is not decoration: `safeStorage` only works inside a
 * ready Electron app, and keeping it injected is what lets this file be tested
 * on a build machine that has no keychain at all.
 *
 * If encryption is unavailable we refuse to store the key rather than writing
 * it in the clear. A missing fallback credential is a prompt; a plaintext one
 * on disk is an incident.
 */

import fs from "node:fs";
import path from "node:path";

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface BoardKeyStoreOptions {
  /** Directory to hold the file. Normally Electron's `userData`. */
  directory: string;
  safeStorage: SafeStorageLike;
  fileName?: string;
}

interface PersistedBoardKeys {
  version: 1;
  /** profileId -> base64 of safeStorage ciphertext. Never a plaintext key. */
  keys: Record<string, string>;
}

const DEFAULT_FILE_NAME = "board-credentials.json";
const FILE_VERSION = 1 as const;

export class BoardKeyStore {
  private readonly filePath: string;
  private readonly safeStorage: SafeStorageLike;

  constructor(options: BoardKeyStoreOptions) {
    this.filePath = path.join(options.directory, options.fileName ?? DEFAULT_FILE_NAME);
    this.safeStorage = options.safeStorage;
  }

  getFilePath(): string {
    return this.filePath;
  }

  isAvailable(): boolean {
    try {
      return this.safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  async load(profileId: string): Promise<string | null> {
    const file = this.read();
    const encoded = file.keys[profileId];
    if (!encoded) {
      return null;
    }

    if (!this.isAvailable()) {
      throw new Error(
        "OS encryption is unavailable, so the stored board API key cannot be decrypted.",
      );
    }

    // A key written by a different OS user, or after a keychain reset, cannot be
    // decrypted. That is a stored credential we can never use again, so drop it
    // and report "none stored" rather than failing every request forever.
    try {
      return this.safeStorage.decryptString(Buffer.from(encoded, "base64"));
    } catch {
      this.write({ ...file, keys: omit(file.keys, profileId) });
      return null;
    }
  }

  async save(profileId: string, key: string): Promise<void> {
    if (!this.isAvailable()) {
      throw new Error(
        "Refusing to store a board API key: this machine reports no OS encryption, and the key "
        + "would have to be written in plaintext.",
      );
    }

    const encrypted = this.safeStorage.encryptString(key).toString("base64");
    const file = this.read();
    this.write({ ...file, keys: { ...file.keys, [profileId]: encrypted } });
  }

  async clear(profileId: string): Promise<void> {
    const file = this.read();
    if (!(profileId in file.keys)) {
      return;
    }
    this.write({ ...file, keys: omit(file.keys, profileId) });
  }

  private read(): PersistedBoardKeys {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as PersistedBoardKeys).version === FILE_VERSION &&
        typeof (parsed as PersistedBoardKeys).keys === "object" &&
        (parsed as PersistedBoardKeys).keys !== null
      ) {
        return parsed as PersistedBoardKeys;
      }
    } catch {
      // Missing or unreadable is the normal first-run state, and a corrupt file
      // should not take the app down over an optional fallback credential.
    }
    return { version: FILE_VERSION, keys: {} };
  }

  private write(file: PersistedBoardKeys): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    // 0600: the ciphertext is useless without the keychain entry, but there is
    // no reason for another account on the machine to be able to read it.
    fs.writeFileSync(this.filePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  }
}

function omit<T extends Record<string, unknown>>(value: T, key: string): T {
  const copy = { ...value };
  delete copy[key];
  return copy;
}
