import type Database from 'better-sqlite3';
import { defaults, assertSettings } from './config.js';
import { DomainError } from './network.js';
import type { ModelClient } from './model.js';
export function savedSettings(db: Database.Database) {
  const row = db.prepare('SELECT value, revision FROM settings WHERE id=1').get() as {value: string; revision: number};
  return { settings: {...defaults, ...JSON.parse(row.value)} as typeof defaults, revision: row.revision };
}
export function saveSettings(db: Database.Database, settings: typeof defaults, expectedRevision: number, model: ModelClient) {
  try { assertSettings(settings); } catch { throw new DomainError('INVALID_SETTINGS'); }
  model.checkSafeSettings(settings);
  if (!db.prepare('UPDATE settings SET value=?, revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE id=1 AND revision=?').run(JSON.stringify(settings), expectedRevision).changes) throw new DomainError('SETTINGS_REVISION_CONFLICT', 409);
  return {ok: true, revision: expectedRevision + 1};
}
