import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const FORMAT_VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export interface FieldCipher {
  encrypt(plaintext: string): Uint8Array<ArrayBuffer>;
  decrypt(payload: Uint8Array): string;
}

/**
 * AES-256-GCM for secrets stored in the DB (MFA secrets, EHR credentials).
 * Layout: [version (1)] [iv (12)] [auth tag (16)] [ciphertext].
 */
export function createFieldCipher(keyBase64: string): FieldCipher {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');

  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const out = new Uint8Array(1 + IV_LENGTH + TAG_LENGTH + ciphertext.length);
      out.set([FORMAT_VERSION], 0);
      out.set(iv, 1);
      out.set(cipher.getAuthTag(), 1 + IV_LENGTH);
      out.set(ciphertext, 1 + IV_LENGTH + TAG_LENGTH);
      return out;
    },
    decrypt(payload) {
      const data = Buffer.from(payload);
      if (data[0] !== FORMAT_VERSION) throw new Error('Unsupported ciphertext version');
      const iv = data.subarray(1, 1 + IV_LENGTH);
      const tag = data.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
      const ciphertext = data.subarray(1 + IV_LENGTH + TAG_LENGTH);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    },
  };
}

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export const hmacSha256 = (secret: string, value: string): string =>
  createHmac('sha256', secret).update(value).digest('base64url');
