import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppData, AuditEntry, Settings, Seller, User } from '../shared/types.ts';

export type EntityTable = 'sellers' | 'financiers' | 'sales' | 'summaries' | 'batches' | 'audit' | 'alerts';
const tables: EntityTable[] = ['sellers', 'financiers', 'sales', 'summaries', 'batches', 'audit', 'alerts'];
export const defaultSettings: Settings = {
  companyName: 'MINAS CELL', monthlyGoalCents: 0, ticketGoalCents: 0,
  workingDays: [1, 2, 3, 4, 5, 6], holidays: [], specialOpenDates: [],
  reminderTime: '08:30', timezone: 'America/Sao_Paulo', alertThreshold: 0.8,
};
export interface StoredUser extends User { passwordHash: string }
export interface ImportSnapshot { sales: AppData['sales']; summaries: AppData['summaries'] }

export class Store {
  readonly db: DatabaseSync;
  constructor(directory = process.env.DATA_DIR || resolve('.data')) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = resolve(directory, 'minas-cell.sqlite');
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    for (const table of tables) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id=1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, role TEXT NOT NULL CHECK(role IN ('admin','seller')), seller_id TEXT, password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS import_snapshots (sequence INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT UNIQUE NOT NULL, before_payload TEXT NOT NULL, after_payload TEXT NOT NULL);
    `);
    if (!this.db.prepare('SELECT id FROM settings WHERE id=1').get()) {
      this.transaction(() => {
        this.setSettings(defaultSettings);
        for (const [id, name, color] of [
          ['mirelly', 'Mirelly', '#8b5cf6'], ['nicolas', 'Nicolas', '#3b82f6'],
          ['vitoria', 'Vitória', '#f59e0b'], ['thales', 'Thales', '#10b981'],
        ]) this.put<Seller>('sellers', { id, name, initials: name.slice(0, 2).toUpperCase(), color, monthlyGoalCents: 0, active: true });
        for (const [id, name] of [['payjoy', 'PayJoy'], ['parcelex', 'Parcelex'], ['odrescred', 'ODRESCRED'], ['brasilcard', 'BrasilCard']]) this.put('financiers', { id, name });
      });
    }
  }
  all<T>(table: EntityTable): T[] {
    return (this.db.prepare(`SELECT payload FROM ${table} ORDER BY rowid`).all() as {payload: string}[]).map(row => JSON.parse(row.payload) as T);
  }
  get<T>(table: EntityTable, id: string): T | undefined {
    const row = this.db.prepare(`SELECT payload FROM ${table} WHERE id=?`).get(id) as {payload: string} | undefined;
    return row ? JSON.parse(row.payload) as T : undefined;
  }
  put<T extends { id: string }>(table: EntityTable, item: T) {
    this.db.prepare(`INSERT INTO ${table}(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`).run(item.id, JSON.stringify(item));
  }
  remove(table: EntityTable, id: string) { this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id); }
  replace<T extends {id: string}>(table: EntityTable, items: T[]) {
    this.db.exec(`DELETE FROM ${table}`);
    for (const item of items) this.put(table, item);
  }
  settings(): Settings { return JSON.parse((this.db.prepare('SELECT payload FROM settings WHERE id=1').get() as {payload: string}).payload) as Settings; }
  setSettings(settings: Settings) {
    this.db.prepare('INSERT INTO settings(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(settings));
  }
  data(): AppData {
    return { sellers: this.all('sellers'), financiers: this.all('financiers'), sales: this.all('sales'),
      summaries: this.all('summaries'), batches: this.all('batches').reverse() as AppData['batches'],
      audit: this.all('audit').reverse() as AppData['audit'], alerts: this.all('alerts').reverse() as AppData['alerts'], settings: this.settings() };
  }
  snapshot(): ImportSnapshot { return { sales: this.all('sales'), summaries: this.all('summaries') }; }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  audit(userName: string, action: string, details: string) {
    this.put<AuditEntry>('audit', { id: randomUUID(), at: new Date().toISOString(), userName, action, details });
  }
  userCount(): number { return Number((this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as {n: number}).n); }
  users(): User[] {
    return this.db.prepare('SELECT id,name,email,role,seller_id AS sellerId FROM users ORDER BY name').all() as unknown as User[];
  }
  userByEmail(email: string): StoredUser | undefined {
    return this.db.prepare('SELECT id,name,email,role,seller_id AS sellerId,password_hash AS passwordHash FROM users WHERE email=? COLLATE NOCASE').get(email) as unknown as StoredUser | undefined;
  }
  insertUser(user: StoredUser) {
    this.db.prepare('INSERT INTO users(id,name,email,role,seller_id,password_hash) VALUES(?,?,?,?,?,?)').run(user.id, user.name, user.email.toLowerCase(), user.role, user.sellerId ?? null, user.passwordHash);
  }
  close() { this.db.close(); }
}
