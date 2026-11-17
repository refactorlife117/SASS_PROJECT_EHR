import { describe, expect, it } from 'vitest';
import { createFieldCipher, hmacSha256 } from './crypto';

const key = Buffer.alloc(32, 1).toString('base64');

describe('createFieldCipher', () => {
  it('round-trips a value and uses a fresh IV each time', () => {
    const cipher = createFieldCipher(key);
    const a = cipher.encrypt('JBSWY3DPEHPK3PXP');
    const b = cipher.encrypt('JBSWY3DPEHPK3PXP');
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(cipher.decrypt(a)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('detects tampering', () => {
    const cipher = createFieldCipher(key);
    const payload = cipher.encrypt('secret');
    payload[payload.length - 1] = (payload[payload.length - 1] ?? 0) ^ 0xff;
    expect(() => cipher.decrypt(payload)).toThrow();
  });

  it('cannot decrypt with a different key', () => {
    const payload = createFieldCipher(key).encrypt('secret');
    const other = createFieldCipher(Buffer.alloc(32, 2).toString('base64'));
    expect(() => other.decrypt(payload)).toThrow();
  });

  it('accepts the key as 64 hex characters (Secrets Manager) as well as base64', () => {
    const hex = 'ab'.repeat(32);
    const payload = createFieldCipher(hex).encrypt('x');
    expect(createFieldCipher(Buffer.from(hex, 'hex').toString('base64')).decrypt(payload)).toBe(
      'x',
    );
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => createFieldCipher(Buffer.alloc(16).toString('base64'))).toThrow();
  });
});

describe('hmacSha256', () => {
  it('is deterministic and keyed', () => {
    expect(hmacSha256('k1', 'v')).toBe(hmacSha256('k1', 'v'));
    expect(hmacSha256('k1', 'v')).not.toBe(hmacSha256('k2', 'v'));
  });
});
