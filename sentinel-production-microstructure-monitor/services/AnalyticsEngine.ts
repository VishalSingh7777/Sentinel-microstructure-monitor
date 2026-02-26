
import { 
  NormalizedMarketTick, SignalOutput, StressLevel, ConfidenceLevel, 
  SignalType, StressScore, CausalSequence, CausalStep, Trade, CriticalEvent,
  WeightContribution, DecisionTrace, StructuralEvent, EventPhase, ResolvedEvent
} from '../types';
import { THEME } from '../constants';
import { CircularBuffer } from './CircularBuffer';

export class AnalyticsEngine {
  private liquidityBuffer = new CircularBuffer<number>(300);
  private bidDepthBuffer = new CircularBuffer<number>(300);
  private askDepthBuffer = new CircularBuffer<number>(300);
  private spreadBuffer = new CircularBuffer<number>(300);
  private priceBuffer = new CircularBuffer<number>(300);
  private volBuffer = new CircularBuffer<number>(60);
  private flowBuffer = new CircularBuffer<{ buy: number, sell: number, buy_count: number, sell_count: number }>(50);
  private whaleBuffer = new CircularBuffer<number>(20);
  private previousStress = 0;
  private previousLevel: StressLevel = StressLevel.STABLE;
  private previousSignalsAligned = 0;
  private lastTrace: DecisionTrace | null = null;
  
  // Forensic Log State
  private lastLogTime = 0;
  private lastLogScore = 0;
  
  // Structural Event Engine State
  private currentEvent: StructuralEvent | null = null;
  private resolvedEvents: ResolvedEvent[] = [];
  private stressHistory = new CircularBuffer<number>(30); // 3 seconds of history for slope

  private dynamicWeights = {
    [SignalType.LIQUIDITY]: 0.35,
    [SignalType.FLOW]: 0.25,
    [SignalType.VOLATILITY]: 0.25,
    [SignalType.FORCED_SELLING]: 0.15
  };

  reset(): void {
    this.liquidityBuffer.clear();
    this.bidDepthBuffer.clear();
    this.askDepthBuffer.clear();
    this.spreadBuffer.clear();
    this.priceBuffer.clear();
    this.volBuffer.clear();
    this.flowBuffer.clear();
    this.whaleBuffer.clear();
    this.stressHistory.clear();
    this.previousStress = 0;
    this.previousLevel = StressLevel.STABLE;
    this.previousSignalsAligned = 0;
    this.lastLogTime = 0;
    this.lastLogScore = 0;
    this.lastTrace = null;
    this.currentEvent = null;
    this.resolvedEvents = [];
  }

  getLastTrace(): DecisionTrace | null {
    return this.lastTrace;
  }

  processTick(tick: NormalizedMarketTick): { 
    signals: Record<SignalType, SignalOutput>, 
    stress: StressScore, 
    causal: CausalSequence,
    criticalEvent: CriticalEvent | null,
    trace: DecisionTrace
  } {
    const signals = {
      [SignalType.LIQUIDITY]: this.processLiquidity(tick),
      [SignalType.FLOW]: this.processFlow(tick),
      [SignalType.VOLATILITY]: this.processVolatility(tick),
      [SignalType.FORCED_SELLING]: this.processForcedSelling(tick)
    };

    const { stress, trace } = this.calculateStressWithTrace(signals, tick);
    
    // Update Structural Event Engine
    this.updateStructuralEvent(stress, signals, tick);
    
    // Map Structural Event to CausalSequence for UI compatibility
    const causal = this.mapEventToCausal(this.currentEvent, this.resolvedEvents);
    
    const criticalEvent = this.detectCriticalEvent(tick, stress, causal);

    return { signals, stress, causal, criticalEvent, trace };
  }

  private updateStructuralEvent(stress: StressScore, signals: Record<SignalType, SignalOutput>, tick: NormalizedMarketTick): void {
    this.stressHistory.push(stress.score);
    const slope = this.calculateSlope();
    const activeSignals = Object.values(signals).filter(s => s.triggered).map(s => s.name);
    
    // Initialize event if needed
    if (!this.currentEvent) {
      if (stress.score > 62) { // Trigger Threshold
        this.currentEvent = {
          id: `EVT-${tick.exchange_timestamp.toString().slice(-6)}`,
          phase: EventPhase.ACCUMULATION,
          catalyst: activeSignals[0] || null, // Lock catalyst
          start_time: tick.exchange_timestamp,
          duration: 0,
          peak_stress: stress.score,
          current_stress: stress.score,
          slope: slope,
          alignment: activeSignals.length,
          propagators: [],
          accelerants: [],
          narrative: 'Latent volatility detected. Pre-shock accumulation in order book.'
        };
      }
      return;
    }

    // Update Event State
    const evt = this.currentEvent;
    evt.current_stress = stress.score;
    evt.peak_stress = Math.max(evt.peak_stress, stress.score);
    evt.duration = tick.exchange_timestamp - evt.start_time;
    evt.slope = slope;
    evt.alignment = activeSignals.length;

    // Update Propagators and Accelerants (excluding catalyst)
    const otherSignals = activeSignals.filter(s => s !== evt.catalyst);
    evt.propagators = otherSignals.slice(0, 2); // First 2 are propagators
    evt.accelerants = otherSignals.slice(2);    // Rest are accelerants

    // Phase Transition Logic
    switch (evt.phase) {
      case EventPhase.ACCUMULATION:
        if (evt.alignment >= 2 && evt.duration > 1500) {
          evt.phase = EventPhase.COORDINATION;
          evt.narrative = 'Vector Synchronization: Risk indicators correlating. Systemic lock forming.';
        } else if (stress.score < 55) {
           this.resolveEvent(tick); // False alarm
        }
        break;

      case EventPhase.COORDINATION:
        if (slope > 4) { // Stress increasing > 4 pts/sec (approx)
          evt.phase = EventPhase.ACCELERATION;
          evt.narrative = 'Velocity Breakout: Stress delta expanding. Order book resilience failing.';
        } else if (stress.score > 75 && evt.alignment >= 3) {
          evt.phase = EventPhase.CASCADE;
          evt.narrative = 'Regime Shift: Structural support collapsed. Liquidity void detected.';
        } else if (stress.score < 55) {
          evt.phase = EventPhase.STABILIZATION;
        }
        break;

      case EventPhase.ACCELERATION:
        if (stress.score > 75) {
          evt.phase = EventPhase.CASCADE;
          evt.narrative = 'CRITICAL: Asymmetric selling pressure overwhelming bid depth.';
        } else if (slope < 0) {
          evt.phase = EventPhase.STABILIZATION;
          evt.narrative = 'Momentum Decay: Selling pressure exhausting. Mean reversion possible.';
        }
        break;

      case EventPhase.CASCADE:
        if (stress.score < 70 && slope < 0) {
          evt.phase = EventPhase.STABILIZATION;
          evt.narrative = 'Cascade Termination: Volatility dampening. Liquidity returning to book.';
        }
        break;

      case EventPhase.STABILIZATION:
        if (stress.score < 50 && evt.duration > 5000) {
           this.resolveEvent(tick);
        } else if (slope > 2) {
           evt.phase = EventPhase.ACCELERATION; // Relapse
           evt.narrative = 'Support Failure: Recovery rejected. Secondary sell-off wave initiating.';
        }
        break;
    }
  }

  private resolveEvent(tick: NormalizedMarketTick): void {
    if (this.currentEvent) {
      this.resolvedEvents.unshift({
        id: this.currentEvent.id,
        catalyst: this.currentEvent.catalyst,
        peak_stress: this.currentEvent.peak_stress,
        duration: this.currentEvent.duration,
        timestamp: tick.exchange_timestamp
      });
      if (this.resolvedEvents.length > 3) this.resolvedEvents.pop();
      this.currentEvent = null;
    }
  }

  private calculateSlope(): number {
    const history = this.stressHistory.getAll();
    if (history.length < 10) return 0;
    // Simple linear regression or just delta over window
    // Using delta over last ~1 second (10 ticks)
    const current = history[history.length - 1];
    const past = history[Math.max(0, history.length - 10)];
    return (current - past); // Points per second (approx)
  }

  private mapEventToCausal(evt: StructuralEvent | null, history: ResolvedEvent[]): CausalSequence {
    if (!evt) {
      return { 
        active: false, 
        steps: [], 
        catalyst_id: null, 
        narrative: 'System Stable', 
        risk_assessment: 'IDLE',
        structural: undefined,
        history: history
      };
    }

    // Map structural event to legacy steps for compatibility if needed, 
    // but UI should prefer 'structural' property
    const steps: CausalStep[] = [];
    if (evt.catalyst) steps.push({ sequence_id: 1, type: 'CATALYST', signal: evt.catalyst, description: 'Initiator', severity: StressLevel.ELEVATED, timestamp: evt.start_time });
    evt.propagators.forEach((s, i) => steps.push({ sequence_id: i+2, type: 'AMPLIFIER', signal: s, description: 'Propagator', severity: StressLevel.STRESSED, timestamp: evt.start_time }));
    evt.accelerants.forEach((s, i) => steps.push({ sequence_id: i+4, type: 'SYSTEMIC', signal: s, description: 'Accelerant', severity: StressLevel.CRITICAL, timestamp: evt.start_time }));

    return {
      active: true,
      steps,
      catalyst_id: evt.catalyst,
      narrative: evt.narrative,
      risk_assessment: `${evt.phase} (${evt.current_stress})`,
      structural: evt,
      history: history
    };
  }

  private determineConfidence(value: number, highThreshold: number, medThreshold: number): ConfidenceLevel {
    if (value >= highThreshold) return ConfidenceLevel.HIGH;
    if (value >= medThreshold) return ConfidenceLevel.MEDIUM;
    return ConfidenceLevel.LOW;
  }

  private processLiquidity(tick: NormalizedMarketTick): SignalOutput {
    // 1. Bid/Ask Depth Analysis
    const currentBidDepth = tick.bids.reduce((sum, [_, qty]) => sum + qty, 0);
    const currentAskDepth = tick.asks.reduce((sum, [_, qty]) => sum + qty, 0);
    
    this.bidDepthBuffer.push(currentBidDepth);
    this.askDepthBuffer.push(currentAskDepth);
    this.spreadBuffer.push(tick.spread_bps);
    this.liquidityBuffer.push(tick.total_depth);

    const bidBaseline = this.bidDepthBuffer.mean() || 1;
    const spreadBaseline = this.spreadBuffer.mean() || 1;
    
    // 2. Volume Balance Index (VBI)
    // Measures the imbalance between buy and sell side depth.
    // VBI = (Bids - Asks) / (Bids + Asks)
    const vbi = (currentBidDepth - currentAskDepth) / (currentBidDepth + currentAskDepth || 1);
    
    // 3. Spread Widening Factor
    // A widening spread indicates a lack of liquidity and increasing uncertainty.
    const spreadExpansion = tick.spread_bps / spreadBaseline;
    
    // 4. Depth Erosion
    const depthChange = ((currentBidDepth - bidBaseline) / bidBaseline) * 100;
    
    // Logic: Risk increases if:
    // - Bid depth is significantly lower than ask depth (negative VBI)
    // - Spread is widening
    // - Bid depth is eroding from its own baseline
    
    const vbiRisk = Math.max(0, -vbi * 100); // Max risk if bids are 0
    const spreadRisk = Math.min(100, Math.max(0, (spreadExpansion - 1) * 200));
    const erosionRisk = depthChange >= 0 ? 0 : Math.min(100, (-depthChange / 25) * 100);
    
    // Weighted combination for liquidity risk
    const risk = (vbiRisk * 0.4) + (spreadRisk * 0.3) + (erosionRisk * 0.3);
    
    const confidence = this.determineConfidence(this.bidDepthBuffer.size(), 60, 20);

    return {
      name: SignalType.LIQUIDITY,
      value: Math.round(risk),
      severity: this.getSeverity(risk),
      triggered: risk > 55,
      raw_metrics: { 
        'VBI': vbi.toFixed(2), 
        'Spread': `${tick.spread_bps.toFixed(2)}bps`,
        'Δ Support': `${depthChange.toFixed(1)}%` 
      },
      explanation: risk > 55 
        ? `Liquidity fragility: ${vbi < -0.3 ? 'Heavy ask-side imbalance' : ''} ${spreadExpansion > 1.5 ? 'Spread widening' : ''} ${depthChange < -15 ? 'Bid erosion' : ''}`.trim()
        : 'Order book liquidity is healthy.',
      confidence: confidence,
      timestamp: tick.processing_timestamp
    };
  }

  private processFlow(tick: NormalizedMarketTick): SignalOutput {
    this.flowBuffer.push({ 
      buy: tick.trades.buy_volume, 
      sell: tick.trades.sell_volume,
      buy_count: tick.trades.buy_count,
      sell_count: tick.trades.sell_count
    });
    
    const history = this.flowBuffer.getAll();
    const totalBuy = history.reduce((sum, item) => sum + item.buy, 0);
    const totalSell = history.reduce((sum, item) => sum + item.sell, 0);
    const totalTrades = history.reduce((sum, item) => sum + item.buy_count + item.sell_count, 0);
    const totalVol = totalBuy + totalSell;

    if (totalVol === 0) return this.defaultSignal(SignalType.FLOW, tick.processing_timestamp);
    
    // 1. Volume Delta (CVD-like)
    const sellRatio = totalSell / totalVol;
    
    // 2. Trade Intensity (Trades per tick/second)
    const intensity = totalTrades / history.length;
    
    // 3. Trade Size Imbalance
    const avgBuySize = totalBuy / (history.reduce((s, i) => s + i.buy_count, 0) || 1);
    const avgSellSize = totalSell / (history.reduce((s, i) => s + i.sell_count, 0) || 1);
    const sizeImbalance = avgSellSize / (avgBuySize || 1);

    // Logic: Risk increases if:
    // - Sells dominate volume (sellRatio > 0.5)
    // - High trade intensity (panic trading)
    // - Sell trades are significantly larger than buy trades
    
    const volumeRisk = Math.max(0, (sellRatio - 0.5) * 200);
    const intensityRisk = Math.min(100, (intensity / 10) * 100); // 10 trades per tick is high
    const sizeRisk = Math.min(100, Math.max(0, (sizeImbalance - 1.2) * 100));

    const risk = (volumeRisk * 0.5) + (intensityRisk * 0.2) + (sizeRisk * 0.3);

    const confidence = this.determineConfidence(totalVol, 5.0, 1.0);

    return {
      name: SignalType.FLOW,
      value: Math.round(risk),
      severity: this.getSeverity(risk),
      triggered: risk > 60,
      raw_metrics: { 
        'Sell %': (sellRatio * 100).toFixed(1) + '%', 
        'Intensity': intensity.toFixed(1),
        'Size Imb': sizeImbalance.toFixed(2)
      },
      explanation: risk > 60 
        ? `Aggressive flow: ${sellRatio > 0.6 ? 'Sell dominance' : ''} ${intensity > 8 ? 'High intensity' : ''} ${sizeImbalance > 1.5 ? 'Large sell orders' : ''}`.trim()
        : 'Transaction flow is orderly.',
      confidence: confidence,
      timestamp: tick.processing_timestamp
    };
  }

  private processVolatility(tick: NormalizedMarketTick): SignalOutput {
    this.priceBuffer.push(tick.price);
    const prices = this.priceBuffer.getAll();
    if (prices.length < 20) return this.defaultSignal(SignalType.VOLATILITY, tick.processing_timestamp);
    
    const shortTerm = prices.slice(-10);
    const getStd = (arr: number[]) => {
      const mean = arr.reduce((a, b) => a + b) / arr.length;
      return Math.sqrt(arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / arr.length);
    };
    
    const stdShort = getStd(shortTerm);
    const stdLong = getStd(prices) || 0.0001;
    
    // 1. Volatility Ratio (Expansion detection)
    const ratio = stdShort / stdLong;
    
    // 2. Trend Bias
    const priceChange = (prices[prices.length - 1] - prices[0]);
    const trendBps = (priceChange / prices[0]) * 10000;
    const isDropping = priceChange < 0;
    
    // 3. Acceleration (Rate of change of price change)
    const mid = Math.floor(prices.length / 2);
    const firstHalfChange = prices[mid] - prices[0];
    const secondHalfChange = prices[prices.length - 1] - prices[mid];
    const acceleration = secondHalfChange - firstHalfChange;
    
    // Logic: Risk increases if:
    // - Volatility is expanding (ratio > 1)
    // - Price is dropping sharply
    // - Price drop is accelerating
    
    const expansionRisk = Math.max(0, (ratio - 1) * 60);
    const trendRisk = isDropping ? Math.min(100, (Math.abs(trendBps) / 20) * 100) : 0; // 20bps drop is high
    const accelerationRisk = (isDropping && acceleration < 0) ? Math.min(100, (Math.abs(acceleration) / (prices[0] * 0.0005)) * 100) : 0;

    const risk = (expansionRisk * 0.4) + (trendRisk * 0.4) + (accelerationRisk * 0.2);

    const confidence = this.determineConfidence(prices.length, 50, 30);

    return {
      name: SignalType.VOLATILITY,
      value: Math.round(risk),
      severity: this.getSeverity(risk),
      triggered: risk > 60,
      raw_metrics: { 
        'Vol Ratio': ratio.toFixed(2), 
        'Trend': `${trendBps.toFixed(1)}bps`,
        'Accel': acceleration.toFixed(2)
      },
      explanation: risk > 60 
        ? `Volatility regime shift: ${ratio > 1.5 ? 'Expansion' : ''} ${trendBps < -10 ? 'Sharp trend' : ''} ${acceleration < 0 ? 'Accelerating' : ''}`.trim()
        : 'Price action is stable.',
      confidence: confidence,
      timestamp: tick.processing_timestamp
    };
  }

  private processForcedSelling(tick: NormalizedMarketTick): SignalOutput {
    const largeSells = tick.trades.large_trades.filter(t => t.side === 'sell');
    const currentLargeVol = largeSells.reduce((s, t) => s + t.quantity, 0);
    
    this.whaleBuffer.push(currentLargeVol);
    const recentWhaleVol = this.whaleBuffer.getAll().reduce((a, b) => a + b, 0);
    
    // 1. Whale Intensity
    const whaleRisk = Math.min(100, (recentWhaleVol / 12) * 100); // 12 BTC in 2s is critical
    
    // 2. Desperation Factor (Selling into thinning bids)
    const currentBidDepth = tick.bids.reduce((sum, [_, qty]) => sum + qty, 0);
    const bidBaseline = this.bidDepthBuffer.mean() || 1;
    const desperation = (currentLargeVol > 0 && currentBidDepth < bidBaseline * 0.8) ? 1.5 : 1.0;
    
    // 3. Cluster Detection
    const clusterRisk = largeSells.length >= 3 ? 20 : 0;

    const risk = Math.min(100, (whaleRisk * desperation) + clusterRisk);

    const totalTrades = tick.trades.buy_count + tick.trades.sell_count;
    const confidence = this.determineConfidence(totalTrades, 50, 10);

    return {
      name: SignalType.FORCED_SELLING,
      value: Math.round(risk),
      severity: this.getSeverity(risk),
      triggered: risk > 60,
      raw_metrics: { 'Whale Vol': recentWhaleVol.toFixed(1), 'Clusters': largeSells.length },
      explanation: risk > 60 ? `Forced selling detected: ${recentWhaleVol.toFixed(1)} BTC whale volume with ${desperation > 1 ? 'low liquidity absorption' : 'high intensity'}.` : 'No forced selling patterns detected.',
      confidence: confidence,
      timestamp: tick.processing_timestamp
    };
  }

  private calculateStressWithTrace(signals: Record<SignalType, SignalOutput>, tick: NormalizedMarketTick): { stress: StressScore, trace: DecisionTrace } {
    const sigArray = Object.values(signals);
    
    // 1. Dynamic Weighting Adjustment
    // If spread is high, liquidity becomes more important.
    // If volatility is high, flow becomes more important.
    const spreadFactor = Math.min(1.5, tick.spread_bps / (this.spreadBuffer.mean() || 1));
    const volFactor = Math.min(1.5, (signals[SignalType.VOLATILITY].value / 50));
    
    this.dynamicWeights[SignalType.LIQUIDITY] = 0.35 * spreadFactor;
    this.dynamicWeights[SignalType.FLOW] = 0.25 * volFactor;
    
    // Normalize weights
    const totalWeight = Object.values(this.dynamicWeights).reduce((a, b) => a + b, 0);
    Object.keys(this.dynamicWeights).forEach(k => {
      this.dynamicWeights[k as SignalType] /= totalWeight;
    });

    // 2. Non-linear Aggregation
    // We use a root-mean-square like approach to emphasize extreme signals
    const weightedSumSquares = sigArray.reduce((sum, sig) => {
      return sum + (this.dynamicWeights[sig.name] * Math.pow(sig.value, 1.5));
    }, 0);
    
    const rawStress = Math.pow(weightedSumSquares, 1/1.5);
    
    const activeSignals = sigArray.filter(s => s?.triggered).length;
    // Shock multiplier is more aggressive if signals are aligned
    const shockMultiplier = 1.0 + (Math.pow(activeSignals, 1.5) * 0.05); 
    const targetStress = Math.min(100, rawStress * shockMultiplier);

    // Adaptive smoothing: faster on the way up, slower on the way down
    const alpha = targetStress > this.previousStress ? 0.4 : 0.1;
    const smoothedStress = (alpha * targetStress) + ((1 - alpha) * this.previousStress);
    const finalScore = Math.round(smoothedStress);
    
    const level = this.classifyLevel(smoothedStress);
    
    // Confidence Calculation
    const confValues = sigArray.map(s => {
        if (s.confidence === ConfidenceLevel.HIGH) return 3;
        if (s.confidence === ConfidenceLevel.MEDIUM) return 2;
        return 1;
    });
    const avgConf = confValues.reduce((a,b) => a+b, 0) / confValues.length;
    let globalConfidence = ConfidenceLevel.LOW;
    if (avgConf > 2.4) globalConfidence = ConfidenceLevel.HIGH;
    else if (avgConf > 1.4) globalConfidence = ConfidenceLevel.MEDIUM;

    // Weight Contributions for Trace
    const weight_contributions: WeightContribution[] = sigArray.map(sig => {
      const weight = this.dynamicWeights[sig.name];
      const contribution = sig.value * weight; // This is a linear approximation for the trace
      return {
        signal: sig.name,
        weight: weight,
        raw_value: sig.value,
        contribution: contribution,
        pct_of_total: rawStress > 0 ? (contribution / rawStress) * 100 : 0
      };
    });

    const confidence_reasons: Record<string, string> = {
      [SignalType.LIQUIDITY]: `Depth: ${this.bidDepthBuffer.size()} samples, Spread: ${tick.spread_bps.toFixed(2)}bps`,
      [SignalType.VOLATILITY]: `Price: ${this.priceBuffer.size()} ticks, Trend: ${signals[SignalType.VOLATILITY].raw_metrics['Trend']}`,
      [SignalType.FLOW]: `Intensity: ${signals[SignalType.FLOW].raw_metrics['Intensity']} trades/tick`,
      [SignalType.FORCED_SELLING]: `Whale Vol: ${signals[SignalType.FORCED_SELLING].raw_metrics['Whale Vol']} BTC`
    };

    const dominant = [...weight_contributions].sort((a,b) => b.contribution - a.contribution)[0];
    const audit_narrative = `Dominant factor: ${dominant.signal}. Dynamic weighting applied (Liquidity weight adjusted by spread factor ${spreadFactor.toFixed(2)}x). Non-linear aggregation used to emphasize outliers. ${activeSignals > 1 ? `Confluence detected (${activeSignals} signals), applying ${shockMultiplier.toFixed(2)}x shock multiplier.` : ''} Stress is ${targetStress > this.previousStress ? 'escalating' : 'receding'}, using ${alpha === 0.4 ? 'aggressive' : 'conservative'} smoothing.`;

    const trace: DecisionTrace = {
      weight_contributions,
      raw_score: rawStress,
      signals_aligned: activeSignals,
      shock_multiplier: shockMultiplier,
      pre_smooth_score: targetStress,
      smoothing_alpha: alpha,
      previous_score: this.previousStress,
      final_score: finalScore,
      confidence_reasons,
      audit_narrative,
      timestamp: tick.exchange_timestamp
    };

    this.previousStress = smoothedStress;
    this.lastTrace = trace;

    const stress: StressScore = {
      score: finalScore,
      raw_score: rawStress,
      level: level,
      color: THEME.stress[level],
      signals_aligned: activeSignals,
      confidence: globalConfidence,
      breakdown: {
        liquidity: signals[SignalType.LIQUIDITY].value,
        flow: signals[SignalType.FLOW].value,
        volatility: signals[SignalType.VOLATILITY].value,
        forcedSelling: signals[SignalType.FORCED_SELLING].value
      },
      timestamp: tick.exchange_timestamp
    };

    return { stress, trace };
  }



  private detectCriticalEvent(tick: NormalizedMarketTick, stress: StressScore, causal: CausalSequence): CriticalEvent | null {
    // 1. Threshold Check: Only care if score is >= 65
    if (stress.score < 65) {
      // If we drop below 60, reset the last log score so next time we cross 65 it triggers immediately
      if (stress.score < 60) {
        this.lastLogScore = 0;
      }
      return null;
    }

    // 2. Throttle & Escalation Check
    // Log if:
    // - It's been > 3 seconds since the last log (Keep-alive / Sustained stress)
    // - OR The score has jumped by > 2 points since the last log (Escalation)
    // - OR This is the first log (lastLogScore is 0)
    
    const timeSinceLast = tick.exchange_timestamp - this.lastLogTime;
    const scoreJump = stress.score > (this.lastLogScore + 2);
    const isFirstLog = this.lastLogScore === 0;

    if (timeSinceLast > 3000 || scoreJump || isFirstLog) {
      const event: CriticalEvent = {
        id: `forensic_${tick.exchange_timestamp}_${Math.floor(Math.random() * 999)}`,
        timestamp: tick.exchange_timestamp,
        price: tick.price,
        stress_score: stress.score,
        level: stress.level,
        primary_factor: causal.catalyst_id || 'Unknown Catalyst',
        narrative: causal.narrative,
        signals: causal.steps.map(s => s.signal)
      };

      this.lastLogTime = tick.exchange_timestamp;
      this.lastLogScore = stress.score;
      
      // Update legacy tracking for compatibility
      this.previousLevel = stress.level;
      this.previousSignalsAligned = stress.signals_aligned;
      
      return event;
    }

    return null;
  }

  private getStressRank(level: StressLevel): number {
    switch (level) {
      case StressLevel.STABLE: return 0;
      case StressLevel.ELEVATED: return 1;
      case StressLevel.STRESSED: return 2;
      case StressLevel.UNSTABLE: return 3;
      case StressLevel.CRITICAL: return 4;
      default: return 0;
    }
  }

  private getSeverity(risk: number): StressLevel {
    if (risk < 30) return StressLevel.STABLE;
    if (risk < 50) return StressLevel.ELEVATED;
    if (risk < 75) return StressLevel.STRESSED;
    return StressLevel.CRITICAL;
  }

  private classifyLevel(score: number): StressLevel {
    if (score < 25) return StressLevel.STABLE;
    if (score < 50) return StressLevel.ELEVATED;
    if (score < 75) return StressLevel.STRESSED;
    if (score < 90) return StressLevel.UNSTABLE;
    return StressLevel.CRITICAL;
  }

  private defaultSignal(name: SignalType, ts: number): SignalOutput {
    return { name, value: 0, severity: StressLevel.STABLE, triggered: false, raw_metrics: {}, explanation: 'Insufficient data.', confidence: ConfidenceLevel.LOW, timestamp: ts };
  }
}
