// SQLite storage via Node's built-in node:sqlite (no npm packages needed).
const { DatabaseSync } = require('node:sqlite');

function open(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, email TEXT, name TEXT, session_v INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS identities (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL, sub TEXT NOT NULL, email TEXT, refresh_enc TEXT, UNIQUE(provider, sub));
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, identity_id INTEGER REFERENCES identities(id) ON DELETE CASCADE,
      ext_id TEXT, name TEXT NOT NULL, grp TEXT NOT NULL DEFAULT 'private', color TEXT NOT NULL, url_enc TEXT,
      UNIQUE(identity_id, ext_id));
    CREATE INDEX IF NOT EXISTS sources_user ON sources(user_id);
  `);
  return db;
}
module.exports = { open };
