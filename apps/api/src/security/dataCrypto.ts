import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface EncryptedValue {
  keyId: string;
  /** version(1) | iv(12) | auth tag(16) | ciphertext */
  payload: Buffer;
}

export class DataKeyError extends Error {}

/**
 * Authenticated encryption (AES-256-GCM) for sensitive text stored at rest. The additional
 * authenticated data binds each ciphertext to the row it belongs to, so a ciphertext copied to
 * another row (or another user) fails to decrypt. Keys come from server configuration only.
 * Old keys can stay in `previous` so data written before a rotation remains readable.
 */
export class DataCipher {
  private readonly keys = new Map<string, Buffer>();

  constructor(
    private readonly currentKeyId: string,
    keys: ReadonlyMap<string, Buffer>,
  ) {
    for (const [id, key] of keys) {
      if (key.length !== KEY_BYTES) throw new DataKeyError(`Encryption key "${id}" must be ${KEY_BYTES} bytes.`);
      this.keys.set(id, key);
    }
    if (!this.keys.has(currentKeyId)) throw new DataKeyError(`Current encryption key "${currentKeyId}" is missing.`);
  }

  /**
   * Parses `DATA_ENCRYPTION_KEY` (base64 of 32 random bytes) plus optional
   * `DATA_ENCRYPTION_PREVIOUS_KEYS` (`id:base64,id2:base64`). Errors never include key material.
   */
  static fromConfig(current: string, currentId: string, previous?: string): DataCipher {
    const keys = new Map<string, Buffer>();
    keys.set(currentId, decodeKey(current, currentId));
    for (const entry of (previous ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const colon = entry.indexOf(":");
      if (colon <= 0) throw new DataKeyError("DATA_ENCRYPTION_PREVIOUS_KEYS entries must look like id:base64key.");
      const id = entry.slice(0, colon);
      if (keys.has(id)) throw new DataKeyError(`Encryption key id "${id}" is used twice.`);
      keys.set(id, decodeKey(entry.slice(colon + 1), id));
    }
    return new DataCipher(currentId, keys);
  }

  get keyId(): string {
    return this.currentKeyId;
  }

  /** Every key id this cipher can decrypt (current and retired). */
  get keyIds(): string[] {
    return [...this.keys.keys()];
  }

  encrypt(plaintext: string, aad: string): EncryptedValue {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.keys.get(this.currentKeyId)!, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { keyId: this.currentKeyId, payload: Buffer.concat([Buffer.of(VERSION), iv, cipher.getAuthTag(), body]) };
  }

  decrypt(value: EncryptedValue, aad: string): string {
    const key = this.keys.get(value.keyId);
    if (!key) throw new DataKeyError(`No encryption key is configured for key id "${value.keyId}".`);
    const { payload } = value;
    if (payload.length < 1 + IV_BYTES + TAG_BYTES || payload[0] !== VERSION) {
      throw new DataKeyError("Stored ciphertext has an unsupported format.");
    }
    const iv = payload.subarray(1, 1 + IV_BYTES);
    const tag = payload.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const body = payload.subarray(1 + IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    } catch {
      throw new DataKeyError("Stored ciphertext failed authentication (wrong key or tampered data).");
    }
  }
}

function decodeKey(value: string, id: string): Buffer {
  const key = Buffer.from(value.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new DataKeyError(`Encryption key "${id}" must be base64 of exactly ${KEY_BYTES} bytes (generate with: openssl rand -base64 32).`);
  }
  return key;
}
