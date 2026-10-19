import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { Request, Response, NextFunction } from 'express';
import type { User } from '../shared/types.ts';
import type { Store } from './store.ts';

const scrypt = promisify(scryptCallback);
const cookieName = 'minas_session';
const lifetime = 12 * 60 * 60 * 1000;
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [algorithm, salt, digest] = hash.split(':');
  if (algorithm !== 'scrypt' || !salt || !digest) return false;
  const key = await scrypt(password, salt, 64) as Buffer;
  const expected = Buffer.from(digest, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}
export function publicUser(user: User): User {
  return { id: user.id, name: user.name, email: user.email, role: user.role, ...(user.sellerId ? {sellerId: user.sellerId} : {}) };
}
function digest(token: string) { return createHash('sha256').update(token).digest('hex'); }
function readToken(req: Request): string | undefined {
  return req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
}
function cookieOptions(req: Request) {
  return { httpOnly: true, sameSite: 'strict' as const, secure: req.secure || req.get('origin')?.startsWith('https://') === true || process.env.COOKIE_SECURE === 'true', path: '/' };
}
export function createSession(store: Store, user: User, req: Request, res: Response) {
  const token = randomBytes(32).toString('base64url');
  store.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
  store.db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run(digest(token), user.id, Date.now() + lifetime);
  res.cookie(cookieName, token, {...cookieOptions(req), maxAge: lifetime});
}
export function endSession(store: Store, req: Request, res: Response) {
  const token = readToken(req);
  if (token) store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token));
  res.clearCookie(cookieName, cookieOptions(req));
}
export function sessionMiddleware(store: Store) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = readToken(req);
    if (token && /^[\w-]{43}$/.test(token)) {
      const row = store.db.prepare('SELECT u.id,u.name,u.email,u.role,u.seller_id AS sellerId FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(digest(token), Date.now()) as unknown as User | undefined;
      if (row) req.user = publicUser(row);
    }
    next();
  };
}
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) { res.status(401).json({error: 'Entre para continuar.'}); return; }
  next();
}
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) { res.status(401).json({error: 'Entre para continuar.'}); return; }
  if (req.user.role !== 'admin') { res.status(403).json({error: 'Acesso permitido apenas ao administrador.'}); return; }
  next();
}
export function sameOrigin(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { next(); return; }
  if (req.get('sec-fetch-site') === 'cross-site') { res.status(403).json({error: 'Origem não autorizada.'}); return; }
  const origin = req.get('origin');
  if (origin) {
    try { if (new URL(origin).host !== req.get('host')) { res.status(403).json({error: 'Origem não autorizada.'}); return; } }
    catch { res.status(403).json({error: 'Origem não autorizada.'}); return; }
  }
  next();
}
declare global { namespace Express { interface Request { user?: User } } }
