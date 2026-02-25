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
  private clockOffset = 0;

  private onTickCallback: (tick: NormalizedMarketTick) => void;
  private onStatusChange: (status: 'CONNECTED' | 'DISCONNECTED') => void;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  private readonly WS_BASE_URL = 'wss://stream.binance.com:9443/ws';

  constructor(
    onTick: (tick: NormalizedMarketTick) => void,
    onStatusChange: (status: 'CONNECTED' | 'DISCONNECTED') => void = () => {}
  ) {
    this.onTickCallback = onTick;
    this.onStatusChange = onStatusChange;
  }

  /**
   * FIX (Bug 7): syncClock now uses AbortController with a 4-second timeout.
   * Previously a slow Netlify edge→Binance round trip could hang indefinitely,
   * blocking all three WebSocket connections from opening.
   */
  private async syncClock(): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    try {
      const start = Date.now();
      const response = await fetch('https://api.binance.com/api/v3/time', {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) throw new Error('Non-OK response from /api/v3/time');
      const end = Date.now();
      const data = await response.json();
      const rtt = (end - start) / 2;
      this.clockOffset = data.serverTime - (end - rtt);
      console.log(`[Binance] Clock synchronized. Offset: ${this.clockOffset}ms`);
    } catch (err) {
      clearTimeout(timeoutId);
      // Non-fatal: fall back to local time. Latency display may be slightly off.
      console.warn('[Binance] Clock sync skipped (timeout or error). Latency display may be inaccurate.', err);
      this.clockOffset = 0;
    }
  }

  async start(): Promise<void> {
    this.isRunning = true;
    console.log('[Binance] Initializing pipeline...');

    // Clock sync with timeout — never blocks WebSocket startup for >4s
    await this.syncClock();

    if (!this.isRunning) return; // stop() may have been called during sync

    this.connectTrades();
    this.connectDepth();
    this.connectTicker();

    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = setInterval(() => this.emitTick(), 100);
  }

  stop(): void {
    this.isRunning = false;
    console.log('[Binance] Stopping feed...');
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
        ws.onmessage = null;
        try { ws.close(); } catch {}
      }
    });
    this.tradeWS = null;
    this.depthWS = null;
    this.tickerWS = null;
  }

  private connectTrades(): void {
    if (!this.isRunning) return;
    try {
      this.tradeWS = new WebSocket(`${this.WS_BASE_URL}/btcusdt@aggTrade`);
    } catch (err) {
      console.error('[Binance] Failed to open trade WebSocket:', err);
      return;
    }

    /**
     * FIX (Bug 5): All onmessage handlers are now wrapped in try/catch.
     * Binance sends ping frames (empty strings), rate-limit envelopes, and
     * connection notices — none of which are valid JSON. Without try/catch,
     * any of these throws an unhandled error that propagates to onerror and
     * drops the connection. This was especially likely on Netlify edge nodes
     * where the initial ping frame often arrives before the first data frame.
     */
    this.tradeWS.onmessage = (e) => {
      try {
        if (!e.data || typeof e.data !== 'string') return;
        const data = JSON.parse(e.data);
        if (!data || typeof data !== 'object') return;

        if (data.E) {
          this.lastExchangeTime = data.E;
          this.lastReceivedTime = Date.now();
        }
        if (!data.p || !data.q) return; // not a trade message

        const trade: Trade = {
          id: data.a,
          price: parseFloat(data.p),
          quantity: parseFloat(data.q),
          timestamp: data.T,
          side: data.m ? 'sell' : 'buy',
        };
        if (!isFinite(trade.price) || !isFinite(trade.quantity)) return;

        this.lastPrice = trade.price;
        this.recentTrades.push(trade);
        if (this.recentTrades.length > 5000) this.recentTrades.splice(0, 1000);
      } catch (err) {
        // Silently discard malformed frames — do NOT rethrow
        console.debug('[Binance] Discarded malformed trade frame:', err);
      }
    };

    this.tradeWS.onerror = (err) => {
      console.error('[Binance] Trade WS error:', err);
    };

    this.tradeWS.onclose = () => {
      if (this.isRunning) {
        console.warn('[Binance] Trade WS closed — reconnecting in 3s...');
        setTimeout(() => this.connectTrades(), 3000);
      }
    };
  }

  private connectDepth(): void {
    if (!this.isRunning) return;
    try {
      // 100ms depth updates — essential for microstructure analysis
      this.depthWS = new WebSocket(`${this.WS_BASE_URL}/btcusdt@depth20@100ms`);
    } catch (err) {
      console.error('[Binance] Failed to open depth WebSocket:', err);
      return;
    }

    this.depthWS.onmessage = (e) => {
      try {
        if (!e.data || typeof e.data !== 'string') return;
        const data = JSON.parse(e.data);
        if (!data || !Array.isArray(data.bids) || !Array.isArray(data.asks)) return;

        this.bids = data.bids
          .map((b: any) => [parseFloat(b[0]), parseFloat(b[1])] as [number, number])
          .filter(([p, q]: [number, number]) => isFinite(p) && isFinite(q) && p > 0 && q > 0);

        this.asks = data.asks
          .map((a: any) => [parseFloat(a[0]), parseFloat(a[1])] as [number, number])
          .filter(([p, q]: [number, number]) => isFinite(p) && isFinite(q) && p > 0 && q > 0);
      } catch (err) {
        console.debug('[Binance] Discarded malformed depth frame:', err);
      }
    };

    this.depthWS.onerror = (err) => {
      console.error('[Binance] Depth WS error:', err);
    };

    this.depthWS.onclose = () => {
      if (this.isRunning) {
        console.warn('[Binance] Depth WS closed — reconnecting in 3s...');
        setTimeout(() => this.connectDepth(), 3000);
      }
    };
  }

  private connectTicker(): void {
    if (!this.isRunning) return;
    try {
      this.tickerWS = new WebSocket(`${this.WS_BASE_URL}/btcusdt@ticker`);
    } catch (err) {
      console.error('[Binance] Failed to open ticker WebSocket:', err);
      return;
    }

    this.tickerWS.onmessage = (e) => {
      try {
        if (!e.data || typeof e.data !== 'string') return;
        const data = JSON.parse(e.data);
        if (!data || !data.v) return;
        const vol = parseFloat(data.v);
        if (isFinite(vol)) this.volume24h = vol;
      } catch (err) {
        console.debug('[Binance] Discarded malformed ticker frame:', err);
      }
    };

    this.tickerWS.onerror = (err) => {
      console.error('[Binance] Ticker WS error:', err);
    };

    this.tickerWS.onclose = () => {
      if (this.isRunning) {
        setTimeout(() => this.connectTicker(), 3000);
      }
    };
  }

  private emitTick(): void {
    if (this.lastPrice === 0 || this.bids.length === 0 || this.asks.length === 0) return;
    if (!isFinite(this.lastPrice) || this.lastPrice <= 0) return;

    try {
      const buyTrades = this.recentTrades.filter(t => t.side === 'buy');
      const sellTrades = this.recentTrades.filter(t => t.side === 'sell');
      const largeThreshold = 0.5;

      const calculateVWAP = (levels: [number, number][]) => {
        let valueSum = 0;
        let weightSum = 0;
        for (const [p, q] of levels) {
          if (isFinite(p) && isFinite(q) && q > 0) {
            valueSum += p * q;
            weightSum += q;
          }
        }
        return weightSum > 0 ? valueSum / weightSum : 0;
      };

      const bidVWAP = calculateVWAP(this.bids) || this.bids[0]?.[0] || 0;
      const askVWAP = calculateVWAP(this.asks) || this.asks[0]?.[0] || 0;
      if (!bidVWAP || !askVWAP) return;

      const effectiveSpread = askVWAP - bidVWAP;
      const midPrice = (this.bids[0][0] + this.asks[0][0]) / 2;
      const spreadBps = (effectiveSpread / midPrice) * 10000;

      const tick: NormalizedMarketTick = {
        exchange_timestamp: this.lastExchangeTime,
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
          large_trades: this.recentTrades.filter(t => t.quantity >= largeThreshold),
        },
        mid_price: midPrice,
        spread: this.asks[0][0] - this.bids[0][0],
        spread_bps: isFinite(spreadBps) ? spreadBps : 0,
        total_depth:
          this.bids.reduce((s, b) => s + b[1], 0) +
          this.asks.reduce((s, a) => s + a[1], 0),
        is_valid: true,
        data_quality: 'GOOD',
      };

      this.onStatusChange('CONNECTED');
      this.onTickCallback(tick);
      this.recentTrades = [];
    } catch (err) {
      console.error('[Binance] emitTick error:', err);
    }
  }
}
