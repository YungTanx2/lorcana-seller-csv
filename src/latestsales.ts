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

const LIMIT = 25;        // Sales per API page (TCGPlayer max)
const MAX_PAGES = 8;     // Cap at 200 sales total per card to bound request time
const LOOKBACK_DAYS = 30; // Discard sales older than 30 days — only recent market matters

/**
 * Fetch completed sales for a TCGPlayer product from the latestsales API.
 * Returns up to MAX_PAGES × LIMIT sales, stopping early if sales older than
 * LOOKBACK_DAYS are encountered (API returns newest-first).
 */
export async function fetchSales(productId: number): Promise<Sale[]> {
  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const allSales: Sale[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * LIMIT;
    let data: any;

    try {
      const resp = await axios.post(
        `${BASE_URL}/${productId}/latestsales`,
        {
          conditions: [],
          languages: [1],
          variants: [],
          listingType: 'All',
          offset,
          limit: LIMIT,
          time: Date.now(),
        },
        { headers: HEADERS, timeout: 10000 }
      );
      data = resp.data;
    } catch {
      // If a page fails, stop and return what we have
      break;
    }

    const results: any[] = Array.isArray(data) ? data : (data.data ?? data.results ?? []);
    if (results.length === 0) break;

    let hitOldSale = false;
    for (const r of results) {
      const orderDate: string = r.orderDate ?? r.purchaseDate ?? '';
      const ts = orderDate ? new Date(orderDate).getTime() : 0;

      allSales.push({
        condition: r.condition ?? r.conditionName ?? '',
        variant: r.variant ?? r.printing ?? '',
        quantity: r.quantity ?? 1,
        purchasePrice: r.purchasePrice ?? r.price ?? 0,
        orderDate,
      });

      if (ts > 0 && ts < cutoff) {
        hitOldSale = true;
      }
    }

    if (hitOldSale || results.length < LIMIT) break;
  }

  return allSales;
}
