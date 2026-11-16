import { hash, verify } from '@node-rs/argon2';

// @node-rs/argon2 defaults to argon2id with OWASP-recommended parameters.
export const hashPassword = (password: string): Promise<string> => hash(password);

let dummyHash: Promise<string> | undefined;

/**
 * Verify a password. With no stored hash (unknown email), verify against a dummy hash anyway so
 * the response time doesn't reveal whether the account exists.
 */
export async function verifyPassword(
  storedHash: string | undefined,
  password: string,
): Promise<boolean> {
  if (storedHash === undefined) {
    dummyHash ??= hash('dummy-password-for-timing');
    await verify(await dummyHash, password);
    return false;
  }
  return verify(storedHash, password);
}
