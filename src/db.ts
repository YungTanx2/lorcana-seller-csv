import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// On Railway, DATABASE_PATH points at a mounted volume (e.g. /data/seller.db) so the
// catalog + session survive redeploys. Locally it falls back to a file in the project root.
const DB_PATH = process.env.DATABASE_PATH ?? path.join(__dirname, '..', 'seller.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Runs immediately at import time — other modules (catalog.ts, pricing.ts, session.ts)
// call db.prepare() at their own module top-level, so the schema must exist before
// anything else that imports './db' finishes loading, not via a separately-called init function.
db.exec(`
  CREATE TABLE IF NOT EXISTS catalog (
    sku_id       INTEGER PRIMARY KEY,
    product_line TEXT NOT NULL,
    set_name     TEXT NOT NULL,
    product_name TEXT NOT NULL,
    number       TEXT NOT NULL,
    rarity       TEXT NOT NULL,
    condition    TEXT NOT NULL,
    printing     TEXT NOT NULL,
    photo_url    TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_catalog_set ON catalog(set_name);

  CREATE TABLE IF NOT EXISTS price_cache (
    sku_id         INTEGER PRIMARY KEY,
    avg_last3      REAL,
    sales_count    INTEGER NOT NULL,
    tcgcsv_market  REAL,
    tcgcsv_low     REAL,
    qualifies      INTEGER NOT NULL,
    computed_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS session (
    sku_id   INTEGER PRIMARY KEY,
    quantity INTEGER NOT NULL
  );
`);

// Lightweight migration: seller dump exports commonly leave "Photo URL" blank, so images are
// instead derived from TCGCSV's own product data during pricing. Added after initial release —
// ALTER TABLE ADD COLUMN rather than a CREATE TABLE change so existing installs pick it up too.
const priceCacheColumns = db.prepare('PRAGMA table_info(price_cache)').all() as { name: string }[];
if (!priceCacheColumns.some((c) => c.name === 'image_url')) {
  db.exec('ALTER TABLE price_cache ADD COLUMN image_url TEXT');
}
