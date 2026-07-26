import express from 'express';
import multer from 'multer';
import path from 'path';
import { parseSellerDump, upsertCatalogRows, getSetNames, getCardsForSet, getCatalogRowsBySkuIds, CatalogImportError } from './catalog';
import { priceSet, repriceForExport, getSettings } from './pricing';
import { setQuantity, getAllQuantities } from './session';
import { buildExportCsv } from './export';

const app = express();
const PORT = process.env.PORT ?? 3010;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/settings', (_req, res) => {
  res.json(getSettings());
});

app.post('/api/catalog/import', upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded.' });
    return;
  }
  try {
    const text = req.file.buffer.toString('utf-8');
    const rows = parseSellerDump(text);
    const result = upsertCatalogRows(rows);
    res.json(result);
  } catch (err) {
    if (err instanceof CatalogImportError) {
      res.status(400).json({ error: err.message });
    } else {
      console.error('[catalog/import]', err);
      res.status(500).json({ error: 'Failed to parse the uploaded file.' });
    }
  }
});

app.get('/api/sets', (_req, res) => {
  res.json(getSetNames());
});

function parseListParam(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

app.get('/api/cards', (req, res) => {
  const setName = req.query.set as string | undefined;
  if (!setName) {
    res.status(400).json({ error: 'Missing required "set" query parameter.' });
    return;
  }
  const cards = getCardsForSet(setName, {
    rarities: parseListParam(req.query.rarities),
    printings: parseListParam(req.query.printings),
  });
  res.json(cards);
});

app.get('/api/price-set', async (req, res) => {
  const setName = req.query.set as string | undefined;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (obj: object) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  if (!setName) {
    send({ type: 'error', message: 'Missing required "set" query parameter.' });
    res.end();
    return;
  }

  try {
    const rows = getCardsForSet(setName); // unfiltered — price the whole set once regardless of UI filters
    send({ type: 'start', total: rows.length });

    await priceSet(setName, rows, {
      onProgress: (p) => send({ type: 'progress', total: p.total, done: p.done }),
    });

    send({ type: 'done' });
  } catch (err) {
    console.error('[price-set]', err);
    send({ type: 'error', message: err instanceof Error ? err.message : 'Pricing failed.' });
  }
  res.end();
});

app.get('/api/session', (_req, res) => {
  res.json(getAllQuantities());
});

app.put('/api/session', (req, res) => {
  const { skuId, quantity } = req.body ?? {};
  if (typeof skuId !== 'number' || typeof quantity !== 'number') {
    res.status(400).json({ error: 'Body must be { skuId: number, quantity: number }.' });
    return;
  }
  setQuantity(skuId, quantity);
  res.json({ ok: true });
});

app.post('/api/export', async (_req, res) => {
  try {
    const quantities = getAllQuantities();
    if (quantities.length === 0) {
      res.status(400).json({ error: 'No quantities set — nothing to export.' });
      return;
    }

    const skuIds = quantities.map((q) => q.skuId);
    const rows = getCatalogRowsBySkuIds(skuIds);
    const rowBySkuId = new Map(rows.map((r) => [r.skuId, r]));

    // Re-price live at export time so the listed price reflects the latest sales, not a stale cache.
    const prices = await repriceForExport(rows);

    const items = quantities
      .map((q) => ({ row: rowBySkuId.get(q.skuId), price: prices.get(q.skuId), quantity: q.quantity }))
      .filter((item): item is { row: NonNullable<typeof item.row>; price: typeof item.price; quantity: number } => !!item.row);

    const { csv, excluded } = buildExportCsv(items);
    res.json({ csv, excluded });
  } catch (err) {
    console.error('[export]', err);
    res.status(500).json({ error: 'Export failed.' });
  }
});

app.listen(PORT, () => {
  console.log(`lorcana-seller-csv listening on port ${PORT}`);
});
