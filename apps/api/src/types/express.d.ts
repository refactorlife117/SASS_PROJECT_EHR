import type { AuthContext } from '../modules/auth/middleware';

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export {};
