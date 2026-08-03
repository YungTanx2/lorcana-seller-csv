import axios from 'axios';
import { Sale } from './types';

const BASE_URL = 'https://mpapi.tcgplayer.com/v2/product';

// TCGPlayer's latestsales API requires browser-like headers — it rejects
// requests without a matching Referer/Origin and a real User-Agent string.
// These headers spoof a Chrome browser; no API key is required.
const HEADERS = {
  'Referer': 'https://www.tcgplayer.com/',
  'Origin': 'https://www.tcgplayer.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
};

const LOOKBACK_DAYS = 30; // Discard sales older than 30 days — only recent market matters

/**
 * Thrown when the latestsales request itself fails (network error, timeout, bot-block, non-JSON
 * response). Callers must NOT treat this the same as "the API returned zero sales" — that
 * distinction is the whole point of throwing instead of returning []. See pricing.ts's catch.
 */
export class SalesFetchError extends Error {
  constructor(productId: number, cause: unknown) {
    super(`Failed to fetch latestsales for product ${productId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'SalesFetchError';
  }
}

/**
 * Fetch completed sales for a TCGPlayer product from the latestsales API.
 *
 * NOTE: unauthenticated requests to this endpoint are hard-capped at exactly 5 results
 * regardless of a card's true sales volume — `offset`/`limit` beyond that are silently ignored
 * and `totalResults` in the response is fabricated (always 5). Real pagination only exists
 * behind a logged-in TCGplayer session, which this app deliberately does not hold (see
 * memory/research_tcgplayer-latestsales-api.md). So this is a single request, not a loop — a
 * multi-page loop here would just be dead code that always executes once.
 *
 * `conditions: [1]` (Near Mint) is sent server-side because it genuinely filters even within the
 * capped 5 — it keeps Lightly/Moderately Played and Damaged sales from consuming slots that
 * would otherwise go toward the Near Mint sales this app actually prices off of. `variants`
 * (printing) has no known working filter value, so printing is still filtered client-side in
 * pricing.ts.
 */
export async function fetchSales(productId: number): Promise<Sale[]> {
  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

  let data: any;
  try {
    const resp = await axios.post(
      `${BASE_URL}/${productId}/latestsales`,
      {
        conditions: [1],
        languages: [1],
        variants: [],
        listingType: 'All',
        offset: 0,
        limit: 25,
        time: Date.now(),
      },
      { headers: HEADERS, timeout: 10000 }
    );
    data = resp.data;
  } catch (err) {
    throw new SalesFetchError(productId, err);
  }

  const results: any[] = Array.isArray(data) ? data : (data.data ?? data.results ?? []);
  const sales: Sale[] = [];

  // Results arrive newest-first, so the first sale older than the cutoff means every
  // subsequent one is too — stop there rather than filtering after the fact.
  for (const r of results) {
    const orderDate: string = r.orderDate ?? r.purchaseDate ?? '';
    const ts = orderDate ? new Date(orderDate).getTime() : 0;
    if (ts === 0 || ts < cutoff) break; // undated rows are treated as stale, not as recent

    sales.push({
      condition: r.condition ?? r.conditionName ?? '',
      variant: r.variant ?? r.printing ?? '',
      quantity: r.quantity ?? 1,
      purchasePrice: r.purchasePrice ?? r.price ?? 0,
      orderDate,
    });
  }

  return sales;
}
