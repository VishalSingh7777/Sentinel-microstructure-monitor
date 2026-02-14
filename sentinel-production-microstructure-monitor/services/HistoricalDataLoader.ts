
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

export class HistoricalDataLoader {
  private readonly symbol = 'BTCUSDT';
  private readonly interval = '1m';
  
  // March 11, 2020 00:00 UTC to March 13, 2020 23:59 UTC
  private readonly startTime = 1583884800000;
  private readonly endTime = 1584143999000;

  // Internal cache to prevent redundant fetches
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
        
        // Safety break if we exceed range
        if (currentStart > this.endTime) break;
      }

      console.log(`[Historical] Processing ${allKlines.length} minutes of data...`);
      const processedData = allKlines.map(k => {
        const open = parseFloat(k[1]);
        const high = parseFloat(k[2]);
        const low = parseFloat(k[3]);
        const close = parseFloat(k[4]);
        const volume = parseFloat(k[5]);
        const takerBuyBaseVolume = parseFloat(k[9]); // Taker buy base asset volume
        
        const { bid_depth, ask_depth } = this.estimateOrderBookDepth(open, high, low, close, volume);
        
        return {
          timestamp: k[0],
          open,
          high,
          low,
          close,
          volume,
          buy_volume: takerBuyBaseVolume,
          sell_volume: volume - takerBuyBaseVolume,
          bid_depth,
          ask_depth
        };
      });

      this.cachedPoints = processedData;
      return processedData;
    } catch (error) {
      console.error('[Historical] Error loading data:', error);
      throw error;
    }
  }

  private estimateOrderBookDepth(open: number, high: number, low: number, close: number, volume: number): { bid_depth: number, ask_depth: number } {
    const volatility = (high - low) / close;
    const depthFactor = Math.max(0.015, 1 - (volatility * 90)); 
    const baseDepth = (volume / 60) * 1.6; 
    
    return {
      bid_depth: baseDepth * depthFactor * (open > close ? 0.65 : 1.25),
      ask_depth: baseDepth * depthFactor * (open < close ? 0.65 : 1.25)
    };
  }

  convertToTick(point: HistoricalDataPoint): NormalizedMarketTick {
    const volatility = (point.high - point.low) / point.close;
    const dynamicSpreadBps = 0.75 + (volatility * 650);
    const spreadPct = dynamicSpreadBps / 10000;
    
    const bids: [number, number][] = [];
    const asks: [number, number][] = [];
    const levels = 10;
    for (let i = 1; i <= levels; i++) {
        const priceOffset = (spreadPct / 2) + ((i - 1) * 0.0006 * (1 + volatility * 10));
        const levelDepthFactor = Math.pow(0.85, i - 1) * (1 / levels) * 5; 
        bids.push([point.close * (1 - priceOffset), point.bid_depth * levelDepthFactor]);
        asks.push([point.close * (1 + priceOffset), point.ask_depth * levelDepthFactor]);
    }

    const dynamicVolume24h = 250000 + (point.volume * 1440 * 0.18);

    return {
      exchange_timestamp: point.timestamp,
      received_timestamp: point.timestamp, 
      processing_timestamp: Date.now(),
      price: point.close,
      volume_24h: dynamicVolume24h,
      bids,
      asks,
      trades: {
        buy_volume: point.buy_volume,
        sell_volume: point.sell_volume,
        buy_count: Math.round(point.buy_volume * 14),
        sell_count: Math.round(point.sell_volume * 14),
        large_trades: point.sell_volume > 35 ? [
            { 
              id: point.timestamp + 2, 
              price: point.close, 
              quantity: point.sell_volume * 0.38, 
              timestamp: point.timestamp, 
              side: 'sell' 
            }
        ] : []
      },
      mid_price: point.close,
      spread: point.close * spreadPct,
      spread_bps: dynamicSpreadBps,
      total_depth: point.bid_depth + point.ask_depth,
      is_valid: true,
      data_quality: 'GOOD'
    };
  }
}
