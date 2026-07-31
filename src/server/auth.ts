// Accounts and sessions. Passwords are scrypt-hashed with a per-user salt;
// sessions are opaque random tokens kept server-side, so the cookie carries no
// claims a stolen copy could forge — only a handle we can revoke.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { store, type User } from './store.js';
import { SECURE_COOKIES } from './config.js';

const COOKIE = 'eh_sess';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

export function id(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

export function hashPassword(pw: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pw, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(pw: string, salt: string, hash: string): boolean {
  const a = scryptSync(pw, salt, 64);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createSession(res: Response, userId: string): void {
  const token = randomBytes(32).toString('hex');
  store.addSession(token, { userId, createdAt: Date.now() });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: SECURE_COOKIES,
    path: '/',
    maxAge: SESSION_TTL,
  });
}

export function destroySession(req: Request, res: Response): void {
  const token = req.cookies?.[COOKIE];
  if (token) store.dropSession(token);
  res.clearCookie(COOKIE, { path: '/' });
}

// Resolve the signed-in user from a request's cookie, or null.
export function currentUser(req: Request): User | null {
  const token = req.cookies?.[COOKIE];
  if (!token) return null;
  const s = store.session(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL) {
    store.dropSession(token);
    return null;
  }
  return store.userById(s.userId) ?? null;
}

// Same resolution from a raw cookie header — used on the WebSocket upgrade,
// which does not pass through Express.
export function userFromCookieHeader(header: string | undefined): User | null {
  if (!header) return null;
  const match = header.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!match) return null;
  const token = decodeURIComponent(match.slice(COOKIE.length + 1));
  const s = store.session(token);
  if (!s) return null;
  return store.userById(s.userId) ?? null;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
