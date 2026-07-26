# lorcana-seller-csv

Browse Disney Lorcana sets, price cards by the average of their last 3 completed sales, and export a TCGplayer Seller Portal-compatible inventory CSV.

## Why this exists

TCGplayer's public price data (via [TCGCSV](https://tcgcsv.com)) has no concept of a seller SKU — the id the Seller Portal's bulk "Pricing" import expects. Those SKU ids, and a few price columns TCGCSV doesn't expose, only exist in a Seller Portal export. This app treats a one-time Seller Portal dump as a **persistent catalog** (SKU ↔ card ↔ printing), then layers live pricing on top from two sources:

1. **TCGCSV** — bulk market prices for a whole set in one call. Used as a cheap gate: cards below a configurable floor (`fetchFloorCents`, default 25¢) are never looked up further.
2. **TCGplayer `latestsales`** — real completed sales, per card. A card is only priced (and only listable) if it has **at least 3 matching sales** (same printing, Near Mint) in the last 30 days; the average of the most recent 3 becomes both the reference market price and the actual listing price. Cards that don't clear that bar are excluded from the export and reported separately — no price is ever guessed.

## Workflow

1. **Import** a TCGplayer Seller Portal "Pricing" export (any Lorcana set(s)) to seed/update the catalog.
2. **Browse** a set: filter by rarity and printing (Normal / Cold Foil / Holofoil), search by name.
3. Prices load lazily per set (cached 24h) the first time you open it.
4. **Enter quantities** — saved automatically, persists across visits.
5. **Export** — re-prices your quantity>0 cards live, downloads a byte-compatible CSV, and lists anything that got excluded (and why).

## Stack

TypeScript, Express, better-sqlite3 (WAL), vanilla single-file frontend (`public/index.html`, no build step). Deployed on Railway with a persistent volume for the SQLite database.

## Local development

```
npm install
npm run dev      # http://localhost:3010
```

## Configuration

`config/settings.json`:

```json
{
  "listThresholdCents": 50,
  "fetchFloorCents": 25,
  "cacheTtlHours": 24
}
```

`DATABASE_PATH` env var overrides where the SQLite file lives (Railway sets this to a volume path).
