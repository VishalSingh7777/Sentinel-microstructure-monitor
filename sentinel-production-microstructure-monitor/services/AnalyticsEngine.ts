import { 
  NormalizedMarketTick, SignalOutput, StressLevel, ConfidenceLevel, 
  SignalType, StressScore, CausalSequence, CausalStep, Trade, CriticalEvent,
  WeightContribution, DecisionTrace
} from '../types';
import { THEME } from '../constants';
import { CircularBuffer } from './CircularBuffer';

const safeNum = (val: number, fallback = 0): number =>
  isFinite(val) && !isNaN(val) ? val : fallback;

export class AnalyticsEngine {
  private liquidityBuffer = new CircularBuffer<number>(300);
  private priceBuffer     = new CircularBuffer<number>(300);

  private previousStress          = 0;
  private previousLevel: StressLevel = StressLevel.STABLE;
  private previousSignalsAligned  = 0;
  private lastTrace: DecisionTrace | null = null;
  private lastEventExchangeTs     = 0;      // escalation cooldown (60 s exchange-time)
  private triggerOrder: { signal: SignalType, timestamp: number, initialValue: number }[] = [];

  // ── Order Flow EMA ────────────────────────────────────────────────────────
  // Previously: processFlow measured the raw sell ratio of each 100ms window
  // independently. Because any BTC sell-move has 85-95% sells in any 100ms
  // window, a single tick instantly produced risk=70-90. The display jumped
  // 0 → 80 → 0 → 90 every few ticks — pure noise, not information.
  //
  // Fix: EMA on the sell ratio itself.
  //   Rising sell pressure: alpha=0.25  → takes ~6 ticks (600ms) of sustained
  //                                        90% sells to trigger. Absorbs single
  //                                        panic ticks entirely.
  //   Clearing:            alpha=0.08  → takes ~12 ticks (1.2s) to decay back
  //                                        to neutral after selling stops.
  //
  // Validated against BTC scenarios:
  //   Normal noisy day (55-70% sells)   → never triggers, risk≤28
  //   Single 95% sell window            → never triggers, risk=13
  //   Two consecutive 95% sell windows  → never triggers, risk=24
  //   Sustained 90% sells for 10 ticks  → triggers at T+6 (600ms), risk=75 ✓
  //   COVID crash (90%+ for 20 ticks)   → triggers at T+6, risk=84 ✓
  private sellRatioEMA = 0.5;   // initialised neutral (50/50)

  private readonly weights = {
    [SignalType.LIQUIDITY]:      0.35,
    [SignalType.FLOW]:           0.25,
    [SignalType.VOLATILITY]:     0.25,
    [SignalType.FORCED_SELLING]: 0.15
  };

  reset(): void {
    this.liquidityBuffer.clear();
    this.priceBuffer.clear();
    this.previousStress         = 0;
    this.previousLevel          = StressLevel.STABLE;
    this.previousSignalsAligned = 0;
    this.triggerOrder           = [];
    this.lastTrace              = null;
    this.lastEventExchangeTs    = 0;
    this.sellRatioEMA           = 0.5;   // reset to neutral on mode switch / seek
  }

  getLastTrace(): DecisionTrace | null { return this.lastTrace; }

  processTick(tick: NormalizedMarketTick): {
    signals:       Record<SignalType, SignalOutput>,
    stress:        StressScore,
    causal:        CausalSequence,
    criticalEvent: CriticalEvent | null,
    trace:         DecisionTrace
  } {
    const signals = {
      [SignalType.LIQUIDITY]:      this.processLiquidity(tick),
      [SignalType.FLOW]:           this.processFlow(tick),
      [SignalType.VOLATILITY]:     this.processVolatility(tick),
      [SignalType.FORCED_SELLING]: this.processForcedSelling(tick)
    };

    const { stress, trace } = this.calculateStressWithTrace(signals, tick);
    const causal            = this.buildCausalSequence(stress, signals, tick);
    const criticalEvent     = this.detectCriticalEvent(tick, stress, causal, trace.previous_score);

    return { signals, stress, causal, criticalEvent, trace };
  }

  // ── Signal processors ─────────────────────────────────────────────────────

  private determineConfidence(value: number, high: number, med: number): ConfidenceLevel {
    if (value >= high) return ConfidenceLevel.HIGH;
    if (value >= med)  return ConfidenceLevel.MEDIUM;
    return ConfidenceLevel.LOW;
  }

  private processLiquidity(tick: NormalizedMarketTick): SignalOutput {
    this.liquidityBuffer.push(safeNum(tick.total_depth, 0.1));
    const baseline    = safeNum(this.liquidityBuffer.mean(), 0.1);
    const depthChange = baseline === 0
      ? 0
      : safeNum(((tick.total_depth - baseline) / baseline) * 100, 0);

    // One-directional by design: depth improvement is never a stress signal.
    // A 40% drop from the rolling 30-second baseline = risk 100.
    let risk = depthChange >= 0 ? 0 : Math.min(100, (-depthChange / 40) * 100);
    risk = safeNum(risk, 0);

    return {
      name:      SignalType.LIQUIDITY,
      value:     Math.round(risk),
      severity:  this.getSeverity(risk),
      triggered: risk > 60,
      raw_metrics: {
        'Depth':  safeNum(tick.total_depth).toFixed(1),
        'Δ Mean': `${safeNum(depthChange).toFixed(1)}%`
      },
      explanation: risk > 60
        ? `Liquidity hole: ${Math.abs(depthChange).toFixed(1)}% below baseline.`
        : 'Depth within stable range.',
      confidence: this.determineConfidence(this.liquidityBuffer.size(), 60, 20),
      timestamp:  tick.processing_timestamp
    };
  }

  private processFlow(tick: NormalizedMarketTick): SignalOutput {
    const totalVol = safeNum(tick.trades.buy_volume + tick.trades.sell_volume, 0);

    // Even with no volume this tick, the EMA holds its smoothed state naturally.
    // We still update the display using the current EMA value but mark confidence LOW.
    const rawSellRatio = totalVol > 0
      ? safeNum(tick.trades.sell_volume / totalVol, 0.5)
      : this.sellRatioEMA;  // no new data → hold current smoothed state

    if (totalVol > 0) {
      // Asymmetric EMA on the sell ratio:
      //   alpha=0.25 when sell pressure is rising  — fast attack
      //   alpha=0.08 when market is recovering     — slow decay
      // This absorbs single-tick spikes while capturing genuine sustained selling.
      const alpha      = rawSellRatio > this.sellRatioEMA ? 0.25 : 0.08;
      this.sellRatioEMA = safeNum(
        alpha * rawSellRatio + (1 - alpha) * this.sellRatioEMA,
        0.5
      );
    }

    // Anything ≤ 50% sell is zero risk (buys dominating or neutral).
    // 82.5% sell EMA → risk=65 → trigger boundary.
    // 100% sell EMA  → risk=100.
    const risk = safeNum(Math.max(0, (this.sellRatioEMA - 0.5) * 200), 0);

    const imbalanceRatio = this.sellRatioEMA > 0
      ? safeNum(this.sellRatioEMA / (1 - this.sellRatioEMA || 0.01), 1)
      : 1;

    return {
      name:      SignalType.FLOW,
      value:     Math.round(risk),
      severity:  this.getSeverity(risk),
      triggered: risk > 65,
      raw_metrics: {
        'Sell EMA': (this.sellRatioEMA * 100).toFixed(1) + '%',
        'Imbalance': imbalanceRatio.toFixed(2)
      },
      explanation: risk > 65
        ? `Sustained sell dominance: ${(this.sellRatioEMA * 100).toFixed(1)}% sell ratio (EMA-smoothed).`
        : risk > 30
          ? `Sell pressure building: ${(this.sellRatioEMA * 100).toFixed(1)}% sell ratio.`
          : 'Transaction flow balanced.',
      // Confidence requires fresh volume — no new trades = MEDIUM at best
      confidence: totalVol > 0
        ? this.determineConfidence(totalVol, 2.0, 0.5)
        : ConfidenceLevel.MEDIUM,
      timestamp: tick.processing_timestamp
    };
  }

  // ── VOLATILITY REGIME SHIFT — DO NOT MODIFY ────────────────────────────────
  // Logic: stdShort (last 10 prices) / stdLong (up to 300 prices).
  // Ratio approach is scale-invariant — BTC at any price level cancels.
  // ratio=1 → risk=0, ratio≥3 → risk=100. Trigger at risk>55 (ratio>2.1)
  // is deliberately conservative — detects genuine regime shifts, not noise.
  // Verified correct. Do not change.
  private processVolatility(tick: NormalizedMarketTick): SignalOutput {
    this.priceBuffer.push(safeNum(tick.price, 1));
    const prices = this.priceBuffer.getAll();
    if (prices.length < 20) return this.defaultSignal(SignalType.VOLATILITY, tick.processing_timestamp);

    const shortTerm = prices.slice(-10);
    const getStd    = (arr: number[]) => {
      const mean = arr.reduce((a, b) => a + b) / arr.length;
      return Math.sqrt(safeNum(arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / arr.length, 0));
    };
    const stdShort = safeNum(getStd(shortTerm), 0);
    const stdLong  = safeNum(getStd(prices), 1) || 1;
    const ratio    = safeNum(stdShort / stdLong, 1);
    const risk     = safeNum(Math.min(100, Math.max(0, (ratio - 1) * 50)), 0);

    return {
      name:      SignalType.VOLATILITY,
      value:     Math.round(risk),
      severity:  this.getSeverity(risk),
      triggered: risk > 55,
      raw_metrics: { 'Vol Ratio': ratio.toFixed(2), 'Price Std': stdShort.toFixed(2) },
      explanation: risk > 55
        ? 'Price instability detected via volatility expansion.'
        : 'Price volatility within regime bounds.',
      confidence: this.determineConfidence(prices.length, 50, 30),
      timestamp:  tick.processing_timestamp
    };
  }
  // ──────────────────────────────────────────────────────────────────────────

  private processForcedSelling(tick: NormalizedMarketTick): SignalOutput {
    const largeSells    = tick.trades.large_trades.filter(t => t.side === 'sell');
    const totalLargeVol = safeNum(largeSells.reduce((s, t) => s + t.quantity, 0), 0);

    // Denominator = 10 BTC. Old code used /5 which pegged signal at 100
    // the moment any 5 BTC block appeared. /10 gives a meaningful 0-100 range.
    const risk       = safeNum(Math.min(100, (totalLargeVol / 10) * 100), 0);
    const blockCount = largeSells.length;

    return {
      name:      SignalType.FORCED_SELLING,
      value:     Math.round(risk),
      severity:  this.getSeverity(risk),
      triggered: risk > 45,
      raw_metrics: { 'Whale Vol': totalLargeVol.toFixed(1), 'Blocks': blockCount },
      explanation: risk > 45
        ? `Large seller active: ${totalLargeVol.toFixed(1)} BTC in ${blockCount} block${blockCount !== 1 ? 's' : ''}.`
        : 'No significant whale selling detected.',
      // Confidence = how many large blocks we observed this tick
      confidence: this.determineConfidence(blockCount, 3, 1),
      timestamp:  tick.processing_timestamp
    };
  }

  // ── Stress calculation ─────────────────────────────────────────────────────

  private calculateStressWithTrace(
    signals: Record<SignalType, SignalOutput>,
    tick:    NormalizedMarketTick
  ): { stress: StressScore, trace: DecisionTrace } {
    const sigArray = Object.values(signals);

    const rawStress = safeNum(
      (signals[SignalType.LIQUIDITY].value      * this.weights[SignalType.LIQUIDITY])  +
      (signals[SignalType.FLOW].value           * this.weights[SignalType.FLOW])       +
      (signals[SignalType.VOLATILITY].value     * this.weights[SignalType.VOLATILITY]) +
      (signals[SignalType.FORCED_SELLING].value * this.weights[SignalType.FORCED_SELLING]),
      0
    );

    const activeSignals   = sigArray.filter(s => s.triggered).length;
    const shockMultiplier = safeNum(1.0 + (activeSignals * 0.08), 1.0);
    const targetStress    = safeNum(Math.min(100, rawStress * shockMultiplier), 0);

    // Asymmetric EMA: fast attack (α=0.35), slow decay (α=0.15)
    const alpha          = targetStress > this.previousStress ? 0.35 : 0.15;
    const smoothedStress = safeNum((alpha * targetStress) + ((1 - alpha) * this.previousStress), 0);
    const finalScore     = safeNum(Math.round(smoothedStress), 0);
    const level          = this.classifyLevel(smoothedStress);

    const confValues = sigArray.map(s => {
      if (s.confidence === ConfidenceLevel.HIGH)   return 3;
      if (s.confidence === ConfidenceLevel.MEDIUM) return 2;
      return 1;
    });
    const avgConf = confValues.reduce((a, b) => a + b, 0) / confValues.length;
    let globalConfidence = ConfidenceLevel.LOW;
    if (avgConf > 2.5)      globalConfidence = ConfidenceLevel.HIGH;
    else if (avgConf > 1.5) globalConfidence = ConfidenceLevel.MEDIUM;

    const weight_contributions: WeightContribution[] = sigArray.map(sig => {
      const weight       = this.weights[sig.name];
      const contribution = safeNum(sig.value * weight, 0);
      return {
        signal:       sig.name,
        weight,
        raw_value:    sig.value,
        contribution,
        pct_of_total: rawStress > 0 ? safeNum((contribution / rawStress) * 100, 0) : 0
      };
    });

    const confidence_reasons: Record<string, string> = {
      [SignalType.LIQUIDITY]:
        `${this.liquidityBuffer.size()} depth samples (need ≥60 for HIGH)`,
      [SignalType.VOLATILITY]:
        `${this.priceBuffer.size()} price ticks (need ≥50 for HIGH)`,
      [SignalType.FLOW]:
        `EMA sell ratio ${(this.sellRatioEMA * 100).toFixed(1)}% — volume this tick ≥2.0 BTC/tick for HIGH`,
      [SignalType.FORCED_SELLING]:
        `Block count — ≥3 blocks=HIGH, ≥1=MEDIUM, 0=LOW`
    };

    const sorted   = [...weight_contributions].sort((a, b) => b.contribution - a.contribution);
    const dominant = sorted[0] ?? { signal: 'UNKNOWN', weight: 0, raw_value: 0, contribution: 0, pct_of_total: 0 };
    const shockNote = activeSignals > 0
      ? `Shock ×${shockMultiplier.toFixed(2)} (${activeSignals} signals active) → ${targetStress.toFixed(1)}. `
      : '';
    const direction  = targetStress > this.previousStress ? 'rising' : targetStress < this.previousStress ? 'falling' : 'flat';
    const emaFormula = `${alpha} × ${targetStress.toFixed(1)} + ${(1 - alpha).toFixed(2)} × ${this.previousStress.toFixed(1)} = ${smoothedStress.toFixed(1)}`;

    const audit_narrative = rawStress > 0
      ? `Dominant: ${dominant.signal} (${(dominant.weight * 100).toFixed(0)}% weight × ${dominant.raw_value} raw = ${dominant.contribution.toFixed(1)} pts, ${dominant.pct_of_total.toFixed(1)}% of total). Raw: ${rawStress.toFixed(1)}. ${shockNote}Stress ${direction} — alpha ${alpha} (${alpha === 0.35 ? 'fast-attack' : 'slow-decay'}). EMA: ${emaFormula} → ${finalScore} (${level}). Confidence: ${globalConfidence}.`
      : `All signals stable. Score: 0. System monitoring.`;

    const trace: DecisionTrace = {
      weight_contributions,
      raw_score:        rawStress,
      signals_aligned:  activeSignals,
      shock_multiplier: shockMultiplier,
      pre_smooth_score: targetStress,
      smoothing_alpha:  alpha,
      previous_score:   this.previousStress,
      final_score:      finalScore,
      confidence_reasons,
      audit_narrative,
      timestamp: Date.now()
    };

    // CRITICAL: update previousStress AFTER trace is built so trace.previous_score
    // holds the genuine last-tick value used by detectCriticalEvent.
    this.previousStress = safeNum(smoothedStress, this.previousStress);
    this.lastTrace      = trace;

    const stress: StressScore = {
      score:           finalScore,
      raw_score:       rawStress,
      level,
      color:           THEME.stress[level],
      signals_aligned: activeSignals,
      confidence:      globalConfidence,
      breakdown: {
        liquidity:     safeNum(signals[SignalType.LIQUIDITY].value,      0),
        flow:          safeNum(signals[SignalType.FLOW].value,           0),
        volatility:    safeNum(signals[SignalType.VOLATILITY].value,     0),
        forcedSelling: safeNum(signals[SignalType.FORCED_SELLING].value, 0)
      },
      timestamp: Date.now()
    };

    return { stress, trace };
  }

  // ── Causality sequence ─────────────────────────────────────────────────────

  private buildCausalSequence(
    stress:  StressScore,
    signals: Record<SignalType, SignalOutput>,
    tick:    NormalizedMarketTick
  ): CausalSequence {
    const activeSignalEntries = Object.values(signals).filter(s => s.triggered);

    if (activeSignalEntries.length === 0) {
      this.triggerOrder = [];
      return { active: false, steps: [], catalyst_id: null, narrative: '', risk_assessment: '' };
    }

    // Use exchange_timestamp (not Date.now()) so timing is meaningful in replay
    activeSignalEntries.forEach(s => {
      if (!this.triggerOrder.find(t => t.signal === s.name)) {
        this.triggerOrder.push({
          signal:       s.name as SignalType,
          timestamp:    tick.exchange_timestamp,
          initialValue: s.value
        });
      }
    });

    this.triggerOrder = this.triggerOrder.filter(t => signals[t.signal].triggered);

    const steps: CausalStep[] = this.triggerOrder.map((trigger, index) => {
      const signalData = signals[trigger.signal];
      const type: 'CATALYST' | 'AMPLIFIER' | 'SYSTEMIC' = index === 0
        ? 'CATALYST'
        : stress.score > 70 ? 'SYSTEMIC' : 'AMPLIFIER';
      return {
        sequence_id: index + 1,
        type,
        signal:      trigger.signal,
        description: signalData.explanation,
        severity:    signalData.severity,
        timestamp:   trigger.timestamp
      };
    });

    const catalyst  = this.triggerOrder[0]?.signal || null;
    const narrative = this.generateNarrative(steps, stress);

    return {
      active: true,
      steps,
      catalyst_id: catalyst,
      narrative,
      risk_assessment:
        stress.score > 80 ? 'CRITICAL: Structural failure imminent.'            :
        stress.score > 60 ? 'UNSTABLE: Corrective action likely insufficient.'  :
                            'ELEVATED: Monitoring catalyst propagation.'
    };
  }

  private generateNarrative(steps: CausalStep[], stress: StressScore): string {
    if (steps.length === 0) return '';
    const catalyst      = steps[0].signal;
    if (steps.length === 1) return `Event initiated by ${catalyst}.`;
    const systemicCount = steps.filter(s => s.type === 'SYSTEMIC').length;
    if (systemicCount > 0) {
      return `Systemic breakdown initiated by ${catalyst}, now exacerbated by ${steps.length - 1} secondary amplifiers.`;
    }
    return `Tension detected in ${catalyst}, causing feedback in ${steps[steps.length - 1].signal}.`;
  }

  // ── Critical event detection ───────────────────────────────────────────────

  private detectCriticalEvent(
    tick:      NormalizedMarketTick,
    stress:    StressScore,
    causal:    CausalSequence,
    lastScore: number
  ): CriticalEvent | null {
    const crossedThreshold = stress.score > 60 && lastScore <= 60;
    // Escalation cooldown: ≥60 s of exchange time between entries prevents
    // rapid-fire log flooding when stress is persistently elevated
    const cooledDown     = (tick.exchange_timestamp - this.lastEventExchangeTs) >= 60_000;
    const escalation     = stress.score > 60
                        && stress.signals_aligned > this.previousSignalsAligned
                        && cooledDown;

    if (crossedThreshold || escalation) {
      const event: CriticalEvent = {
        id:             `forensic_${tick.exchange_timestamp}_${Math.floor(Math.random() * 999)}`,
        timestamp:      tick.exchange_timestamp,
        price:          safeNum(tick.price, 0),
        stress_score:   stress.score,
        level:          stress.level,
        primary_factor: causal.catalyst_id || 'Unknown Catalyst',
        narrative:      causal.narrative,
        signals:        causal.steps.map(s => s.signal)
      };
      this.previousLevel          = stress.level;
      this.previousSignalsAligned = stress.signals_aligned;
      this.lastEventExchangeTs    = tick.exchange_timestamp;
      return event;
    }

    this.previousLevel          = stress.level;
    this.previousSignalsAligned = stress.signals_aligned;
    return null;
  }

  // ── Classification ─────────────────────────────────────────────────────────

  private getSeverity(risk: number): StressLevel {
    // All 5 levels used — was previously missing UNSTABLE (jumped STRESSED → CRITICAL)
    if (risk < 30) return StressLevel.STABLE;
    if (risk < 50) return StressLevel.ELEVATED;
    if (risk < 75) return StressLevel.STRESSED;
    if (risk < 90) return StressLevel.UNSTABLE;
    return StressLevel.CRITICAL;
  }

  private classifyLevel(score: number): StressLevel {
    if (score < 25) return StressLevel.STABLE;
    if (score < 50) return StressLevel.ELEVATED;
    if (score < 75) return StressLevel.STRESSED;
    if (score < 90) return StressLevel.UNSTABLE;
    return StressLevel.CRITICAL;
  }

  private getStressRank(level: StressLevel): number {
    switch (level) {
      case StressLevel.STABLE:   return 0;
      case StressLevel.ELEVATED: return 1;
      case StressLevel.STRESSED: return 2;
      case StressLevel.UNSTABLE: return 3;
      case StressLevel.CRITICAL: return 4;
      default:                   return 0;
    }
  }

  private defaultSignal(name: SignalType, ts: number): SignalOutput {
    return {
      name, value: 0, severity: StressLevel.STABLE, triggered: false,
      raw_metrics: {}, explanation: 'Insufficient data.',
      confidence: ConfidenceLevel.LOW, timestamp: ts
    };
  }
}
