import { NormalizedMarketTick } from '../types';

export interface HistoricalDataPoint {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buy_volume: number;
  sell_volume: number;
  bid_depth: number;
  ask_depth: number;
}

// Safe number helper — replaces NaN/Infinity with fallback
const safe = (val: number, fallback = 0): number =>
  isFinite(val) && !isNaN(val) ? val : fallback;

export class HistoricalDataLoader {
  private readonly symbol = 'BTCUSDT';
  private readonly interval = '1m';
  private readonly startTime = 1583884800000;
  private readonly endTime = 1584143999000;
  private cachedPoints: HistoricalDataPoint[] | null = null;

  async loadCovidCrash(): Promise<HistoricalDataPoint[]> {
    if (this.cachedPoints) {
      console.log('[Historical] Returning cached COVID Crash data.');
      return this.cachedPoints;
    }

    console.log('[Historical] Fetching COVID Crash data from Binance...');
    let allKlines: any[] = [];
    let currentStart = this.startTime;

    try {
      while (currentStart < this.endTime) {
        const response = await fetch(
          `https://api.binance.com/api/v3/klines?symbol=${this.symbol}&interval=${this.interval}&startTime=${currentStart}&limit=1000`
        );
        if (!response.ok) throw new Error('Failed to fetch historical data');
        const data = await response.json();
        if (data.length === 0) break;
        allKlines = [...allKlines, ...data];
        currentStart = data[data.length - 1][0] + 60000;
        if (currentStart > this.endTime) break;
      }

      console.log(`[Historical] Processing ${allKlines.length} minutes of data...`);
      const processedData = allKlines.map(k => {
        const open  = safe(parseFloat(k[1]), 1);
        const high  = safe(parseFloat(k[2]), 1);
        const low   = safe(parseFloat(k[3]), 1);
        const close = safe(parseFloat(k[4]), 1) || 1; // never 0
        const volume = safe(parseFloat(k[5]), 0);
        const takerBuyBaseVolume = safe(parseFloat(k[9]), 0);

        const { bid_depth, ask_depth } = this.estimateOrderBookDepth(open, high, low, close, volume);

        return {
          timestamp: k[0],
          open, high, low, close, volume,
          buy_volume: takerBuyBaseVolume,
          sell_volume: safe(volume - takerBuyBaseVolume, 0),
          bid_depth, ask_depth
        };
      });

      this.cachedPoints = processedData;
      return processedData;
    } catch (error) {
      console.error('[Historical] Error loading data:', error);
      throw error;
    }
  }

  private estimateOrderBookDepth(
    open: number, high: number, low: number, close: number, volume: number
  ): { bid_depth: number, ask_depth: number } {
    const volatility = safe((high - low) / close, 0.01);
    const depthFactor = Math.max(0.015, 1 - (volatility * 90));
    const baseDepth = safe((volume / 60) * 1.6, 0.1);

    return {
      bid_depth: safe(baseDepth * depthFactor * (open > close ? 0.65 : 1.25), 0.1),
      ask_depth: safe(baseDepth * depthFactor * (open < close ? 0.65 : 1.25), 0.1)
    };
  }

  convertToTick(point: HistoricalDataPoint): NormalizedMarketTick {
    const closePrice = point.close || 1; // never divide by zero
    const rawVolatility = safe((point.high - point.low) / closePrice, 0.001);
    const volatility = Math.min(rawVolatility, 0.5); // cap at 50% so spread never explodes
    const dynamicSpreadBps = safe(0.75 + (volatility * 650), 1);
    const spreadPct = dynamicSpreadBps / 10000;

    const bids: [number, number][] = [];
    const asks: [number, number][] = [];
    const levels = 10;

    for (let i = 1; i <= levels; i++) {
      const rawOffset = (spreadPct / 2) + ((i - 1) * 0.0006 * (1 + volatility * 10));
      const priceOffset = safe(rawOffset, spreadPct / 2);
      const levelDepthFactor = safe(Math.pow(0.85, i - 1) * (1 / levels) * 5, 0.01);

      bids.push([
        safe(closePrice * (1 - priceOffset), closePrice * 0.999),
        safe(point.bid_depth * levelDepthFactor, 0.01)
      ]);
      asks.push([
        safe(closePrice * (1 + priceOffset), closePrice * 1.001),
        safe(point.ask_depth * levelDepthFactor, 0.01)
      ]);
    }

    const dynamicVolume24h = safe(250000 + (point.volume * 1440 * 0.18), 250000);
    const totalDepth = safe(point.bid_depth + point.ask_depth, 0.1);

    return {
      exchange_timestamp: point.timestamp,
      received_timestamp: point.timestamp,
      processing_timestamp: Date.now(),
      price: closePrice,
      volume_24h: dynamicVolume24h,
      bids,
      asks,
      trades: {
        buy_volume: safe(point.buy_volume, 0),
        sell_volume: safe(point.sell_volume, 0),
        buy_count: safe(Math.round(point.buy_volume * 14), 0),
        sell_count: safe(Math.round(point.sell_volume * 14), 0),
        large_trades: point.sell_volume > 35 ? [{
          id: point.timestamp + 2,
          price: closePrice,
          quantity: safe(point.sell_volume * 0.38, 0),
          timestamp: point.timestamp,
          side: 'sell'
        }] : []
      },
      mid_price: closePrice,
      spread: safe(closePrice * spreadPct, 0.01),
      spread_bps: dynamicSpreadBps,
      total_depth: totalDepth,
      is_valid: true,
      data_quality: 'GOOD'
    };
  }
}
