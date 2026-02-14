
import { NormalizedMarketTick, Trade } from '../types';

export class BinanceService {
  private tradeWS: WebSocket | null = null;
  private depthWS: WebSocket | null = null;
  private tickerWS: WebSocket | null = null;
  
  private lastPrice = 0;
  private volume24h = 0;
  private bids: [number, number][] = [];
  private asks: [number, number][] = [];
  private recentTrades: Trade[] = [];
  
  private lastExchangeTime = 0;
  private lastReceivedTime = 0;
  private clockOffset = 0; // Difference between Binance server time and local time
  
  private onTickCallback: (tick: NormalizedMarketTick) => void;
  private intervalId: any = null;

  // Use the recommended port 9443 for better stability
  private readonly WS_BASE_URL = 'wss://stream.binance.com:9443/ws';

  constructor(onTick: (tick: NormalizedMarketTick) => void) {
    this.onTickCallback = onTick;
  }

  /**
   * Synchronizes the local clock with Binance server time to ensure
   * latency calculations (received_timestamp - exchange_timestamp) are accurate.
   */
  private async syncClock(): Promise<void> {
    try {
      const start = Date.now();
      const response = await fetch('https://api.binance.com/api/v3/time');
      if (!response.ok) throw new Error('Time sync failed');
      const end = Date.now();
      const data = await response.json();
      
      // Calculate Round Trip Time (RTT) to estimate one-way latency
      const rtt = (end - start) / 2;
      // offset = serverTime - (localTimeAtServerArrival)
      this.clockOffset = data.serverTime - (end - rtt);
      
      console.log(`[Binance] Clock Synchronized. Offset: ${this.clockOffset}ms`);
    } catch (err) {
      console.warn('[Binance] Clock sync failed, falling back to local time. Latency display may be inaccurate.');
      this.clockOffset = 0;
    }
  }

  async start(): Promise<void> {
    console.log('[Binance] Initializing High-Speed Pipeline...');
    
    // Perform clock sync before starting streams
    await this.syncClock();
    
    this.connectTrades();
    this.connectDepth();
    this.connectTicker();
    
    if (this.intervalId) clearInterval(this.intervalId);
    
    // Increased frequency from 1000ms to 100ms for institutional-grade responsiveness
    this.intervalId = setInterval(() => {
      this.emitTick();
    }, 100);
  }

  stop(): void {
    console.log('[Binance] Stopping Live Feed...');
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.closeSockets();
  }

  private closeSockets(): void {
    [this.tradeWS, this.depthWS, this.tickerWS].forEach(ws => {
      if (ws) {
        ws.onclose = null; 
        ws.onerror = null;
        ws.close();
      }
    });
    this.tradeWS = null;
    this.depthWS = null;
    this.tickerWS = null;
  }

  private connectTrades(): void {
    this.tradeWS = new WebSocket(`${this.WS_BASE_URL}/btcusdt@aggTrade`);
    this.tradeWS.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.E) {
        this.lastExchangeTime = data.E;
        this.lastReceivedTime = Date.now();
      }

      const trade: Trade = {
        id: data.a,
        price: parseFloat(data.p),
        quantity: parseFloat(data.q),
        timestamp: data.T,
        side: data.m ? 'sell' : 'buy'
      };
      this.lastPrice = trade.price;
      this.recentTrades.push(trade);
      
      // Prevent memory overflow on extreme volatility
      if (this.recentTrades.length > 5000) this.recentTrades.splice(0, 1000);
    };
    
    this.tradeWS.onclose = () => {
      if (this.intervalId) {
        setTimeout(() => this.connectTrades(), 3000);
      }
    };
  }

  private connectDepth(): void {
    // 100ms depth updates are essential for microstructure analysis
    this.depthWS = new WebSocket(`${this.WS_BASE_URL}/btcusdt@depth20@100ms`);
    this.depthWS.onmessage = (e) => {
      const data = JSON.parse(e.data);
      this.bids = data.bids.map((b: any) => [parseFloat(b[0]), parseFloat(b[1])]);
      this.asks = data.asks.map((a: any) => [parseFloat(a[0]), parseFloat(a[1])]);
    };
    this.depthWS.onclose = () => {
      if (this.intervalId) setTimeout(() => this.connectDepth(), 3000);
    };
  }

  private connectTicker(): void {
    this.tickerWS = new WebSocket(`${this.WS_BASE_URL}/btcusdt@ticker`);
    this.tickerWS.onmessage = (e) => {
      const data = JSON.parse(e.data);
      this.volume24h = parseFloat(data.v);
    };
    this.tickerWS.onclose = () => {
      if (this.intervalId) setTimeout(() => this.connectTicker(), 3000);
    };
  }

  private emitTick(): void {
    if (this.lastPrice === 0 || this.bids.length === 0 || this.asks.length === 0) {
      return;
    }

    const buyTrades = this.recentTrades.filter(t => t.side === 'buy');
    const sellTrades = this.recentTrades.filter(t => t.side === 'sell');
    const largeThreshold = 0.5;

    const calculateVWAP = (levels: [number, number][]) => {
      let valueSum = 0;
      let weightSum = 0;
      for (const [p, q] of levels) {
        valueSum += p * q;
        weightSum += q;
      }
      return weightSum > 0 ? valueSum / weightSum : 0;
    };

    const bidVWAP = calculateVWAP(this.bids) || this.bids[0][0];
    const askVWAP = calculateVWAP(this.asks) || this.asks[0][0];
    
    const effectiveSpread = askVWAP - bidVWAP;
    const midPrice = (this.bids[0][0] + this.asks[0][0]) / 2;
    const spreadBps = (effectiveSpread / midPrice) * 10000;

    const tick: NormalizedMarketTick = {
      exchange_timestamp: this.lastExchangeTime,
      // Apply clock offset to local arrival time for accurate latency calculation
      received_timestamp: this.lastReceivedTime + this.clockOffset,
      processing_timestamp: Date.now() + this.clockOffset,
      price: this.lastPrice,
      volume_24h: this.volume24h,
      bids: this.bids,
      asks: this.asks,
      trades: {
        buy_volume: buyTrades.reduce((s, t) => s + t.quantity, 0),
        sell_volume: sellTrades.reduce((s, t) => s + t.quantity, 0),
        buy_count: buyTrades.length,
        sell_count: sellTrades.length,
        large_trades: this.recentTrades.filter(t => t.quantity >= largeThreshold)
      },
      mid_price: midPrice,
      spread: this.asks[0][0] - this.bids[0][0],
      spread_bps: spreadBps,
      total_depth: this.bids.reduce((s, b) => s + b[1], 0) + this.asks.reduce((s, a) => s + a[1], 0),
      is_valid: true,
      data_quality: 'GOOD'
    };

    this.onTickCallback(tick);
    this.recentTrades = []; 
  }
}
