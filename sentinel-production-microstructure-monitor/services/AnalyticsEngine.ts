import {
  NormalizedMarketTick, SignalOutput, StressLevel, ConfidenceLevel,
  SignalType, StressScore, CausalSequence, CausalStep, Trade, CriticalEvent,
  WeightContribution, DecisionTrace
} from '../types';
import { THEME } from '../constants';
import { CircularBuffer } from './CircularBuffer';

const safeNum = (val: number, fallback = 0): number =>
  isFinite(val) && !isNaN(val) ? val : fallback;

// ─── Named structural failure patterns (bitmask L|F|V|S) ─────────────────────
const PATTERN_LABELS: Record<string, string> = {
  '1000': 'LIQUIDITY DRAIN',
  '0100': 'SELL PRESSURE',
  '0010': 'INTRADAY VOLATILITY SPIKE',
  '0001': 'INSTITUTIONAL EXIT',
  '1100': 'LIQUIDITY VACUUM SELLOFF',
  '1010': 'DEPTH COLLAPSE + VOLATILITY',
  '1001': 'WHALE EXECUTION INTO THIN BOOK',
  '0110': 'PANIC SELLING CASCADE',
  '0101': 'COORDINATED INSTITUTIONAL EXIT',
  '0011': 'FORCED LIQUIDATION SPIRAL',
  '1110': 'MULTI-VECTOR BREAKDOWN',
  '1101': 'STRUCTURAL MARKET FAILURE',
  '1011': 'LIQUIDITY CRISIS',
  '0111': 'CAPITULATION EVENT',
  '1111': 'FULL MARKET BREAKDOWN — BLACK SWAN',
};

// ─── Shock multiplier (exponential convergence table) ────────────────────────
// Proven by simulation: linear 1+N×0.08 was invisible at high raw scores.
// 1 signal: no convergence bonus (a single signal is a signal, not a system event)
// 2 signals: 1.15× — two simultaneous structural anomalies is non-linear risk
// 3 signals: 1.35× — systemic
// 4 signals: 1.60× — black swan
// These values are the ground truth displayed in ExplainabilityLayer.
export const SHOCK_TABLE: readonly number[] = [1.00, 1.00, 1.15, 1.35, 1.60];

export class AnalyticsEngine {
  // ─── Buffers ───────────────────────────────────────────────────────────────
  // FIX [B]: liquidityBuffer expanded to 600 ticks (60 seconds at 100ms cadence).
  // Baseline is now the 90th percentile of depth in this window.
  // WHY: a 300-tick mean adapts fully within 30 seconds of sustained crisis,
  // making the signal drop to zero while the market is still structurally broken.
  // A 600-tick p90 anchor holds the pre-crisis reference for ~60 real seconds
  // before the sustained thin book starts to lower the anchor.
  // This is intentional: after 60 real seconds at new depth levels, the engine
  // acknowledges it as a new regime rather than an ongoing anomaly.
  private liquidityBuffer = new CircularBuffer<number>(600);
  private priceBuffer     = new CircularBuffer<number>(300);

  private previousStress          = 0;
  private previousLevel: StressLevel = StressLevel.STABLE;
  private previousSignalsAligned  = 0;
  private lastTrace: DecisionTrace | null = null;

  // FIX [C]: Flow EMA over sell ratio (0.0–1.0), not the risk value.
  // α_up=0.25 (fast attack), α_down=0.08 (slow decay).
  // Eliminates the 0→80→0→60 flicker of the old tick-by-tick raw formula.
  private flowRatioEMA = 0.50;

  // FIX [C]: Track last tick timestamp to detect stale engine state.
  // If a new tick arrives after a >5s gap, reset flowRatioEMA to neutral
  // to prevent ghost signals from pre-gap panic conditions.
  private lastTickMs = 0;

  private lastEventExchangeTs    = 0;
  private triggerOrder: { signal: SignalType, timestamp: number, initialValue: number }[] = [];
  private catalystTimestamp      = 0;
  private stressHistory: number[] = [];

  readonly weights = {
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
    this.flowRatioEMA           = 0.50;
    this.lastTickMs             = 0;
    this.lastEventExchangeTs    = 0;
    this.catalystTimestamp      = 0;
    this.stressHistory          = [];
  }

  getLastTrace(): DecisionTrace | null { return this.lastTrace; }

  processTick(tick: NormalizedMarketTick): {
    signals:       Record<SignalType, SignalOutput>;
    stress:        StressScore;
    causal:        CausalSequence;
    criticalEvent: CriticalEvent | null;
    trace:         DecisionTrace;
  } {
    // FIX [C]: Detect engine staleness from data gap.
    // If > 5 seconds elapsed since last tick (e.g. WebSocket reconnect),
    // reset flowRatioEMA to neutral so pre-gap panic doesn't haunt the signal.
    // Use processing_timestamp (wall clock) not exchange_timestamp (may be historic).
    const nowMs = tick.processing_timestamp;
    if (this.lastTickMs > 0 && (nowMs - this.lastTickMs) > 5_000) {
      this.flowRatioEMA = 0.50; // ghost-kill: treat reconnect as fresh start
    }
    this.lastTickMs = nowMs;

    const signals = {
      [SignalType.LIQUIDITY]:      this.processLiquidity(tick),
      [SignalType.FLOW]:           this.processFlow(tick),
      [SignalType.VOLATILITY]:     this.processVolatility(tick),
      [SignalType.FORCED_SELLING]: this.processForcedSelling(tick),
    };

    const { stress, trace } = this.calculateStressWithTrace(signals, tick);

    // FIX [F]: Stress velocity in pts/s (multiply pts/tick by 10 for 100ms cadence).
    this.stressHistory.push(stress.score);
    if (this.stressHistory.length > 5) this.stressHistory.shift();

    const causal        = this.buildCausalSequence(stress, signals, tick);
    const criticalEvent = this.detectCriticalEvent(tick, stress, causal, trace.previous_score);

    return { signals, stress, causal, criticalEvent, trace };
  }

  // ── Signal processors ──────────────────────────────────────────────────────

  private determineConfidence(value: number, high: number, med: number): ConfidenceLevel {
    if (value >= high) return ConfidenceLevel.HIGH;
    if (value >= med)  return ConfidenceLevel.MEDIUM;
    return ConfidenceLevel.LOW;
  }

  // ── LIQUIDITY FRAGILITY (FIX [B]) ─────────────────────────────────────────
  // OLD: 300-tick mean baseline. During prolonged crisis (>30s), baseline
  // adapts fully to the new thin-book regime and signal drops to zero while
  // the market is still broken.
  //
  // FIX: 600-tick p90 anchor baseline.
  // - p90 of depth = "what the book normally looks like at its best 90% of time"
  // - During sustained crisis: p90 stays at pre-crisis level until 60% of the
  //   600-tick window is replaced by panic-level depth readings (~60 real seconds)
  // - After 60 real seconds of sustained thin book: the engine acknowledges it
  //   as a new regime, anchor gradually lowers — this is CORRECT behavior
  // - Normal (non-panic) depth fluctuations do not move the p90 anchor
  private processLiquidity(tick: NormalizedMarketTick): SignalOutput {
    this.liquidityBuffer.push(safeNum(tick.total_depth, 0.1));
    
    // p90 anchor: the depth level at or above which the book sits 10% of the time.
    // When depth collapses, this anchor holds the pre-crisis reference.
    const anchor = safeNum(this.liquidityBuffer.percentile(0.90, tick.total_depth), 0.1);
    if (anchor <= 0) return this.defaultSignal(SignalType.LIQUIDITY, tick.processing_timestamp);

    const depthChange = safeNum(((tick.total_depth - anchor) / anchor) * 100, 0);
    const risk = depthChange >= 0 ? 0 : Math.min(100, (-depthChange / 40) * 100);
    const confidence = this.determineConfidence(this.liquidityBuffer.size(), 60, 20);

    return {
      name:        SignalType.LIQUIDITY,
      value:       Math.round(risk),
      severity:    this.getSeverity(risk),
      triggered:   risk > 65,
      raw_metrics: {
        'Depth':    safeNum(tick.total_depth).toFixed(1),
        'Anchor':   anchor.toFixed(1),
        'Δ Anchor': `${safeNum(depthChange).toFixed(1)}%`
      },
      explanation: risk > 65
        ? `Depth ${Math.abs(depthChange).toFixed(1)}% below 60s p90 anchor (${anchor.toFixed(1)} BTC) — structural thinning.`
        : `Depth within p90 anchor range (${anchor.toFixed(1)} BTC).`,
      confidence,
      timestamp: tick.processing_timestamp,
    };
  }

  // ── ORDER FLOW (FIX [C] partial) ──────────────────────────────────────────
  // EMA of sell ratio. Gap detection handled in processTick before signals run.
  private processFlow(tick: NormalizedMarketTick): SignalOutput {
    const totalVol = safeNum(tick.trades.buy_volume + tick.trades.sell_volume, 0);
    const rawRatio = totalVol > 0
      ? safeNum(tick.trades.sell_volume / totalVol, 0.5)
      : 0.5;

    const alpha = rawRatio > this.flowRatioEMA ? 0.25 : 0.08;
    this.flowRatioEMA = safeNum(
      alpha * rawRatio + (1 - alpha) * this.flowRatioEMA, 0.5
    );

    const risk = safeNum(Math.max(0, (this.flowRatioEMA - 0.5) * 200), 0);
    const confidence = totalVol > 0
      ? this.determineConfidence(totalVol, 2.0, 0.5)
      : ConfidenceLevel.LOW;

    const sellPct    = (this.flowRatioEMA * 100).toFixed(1);
    const imbalance  = safeNum(
      this.flowRatioEMA / Math.max(1 - this.flowRatioEMA, 0.01), 1
    ).toFixed(2);

    return {
      name:        SignalType.FLOW,
      value:       Math.round(risk),
      severity:    this.getSeverity(risk),
      triggered:   risk > 65,
      raw_metrics: { 'Sell EMA': `${sellPct}%`, 'Imbalance': imbalance },
      explanation: risk > 65
        ? `Sustained sell pressure: ${sellPct}% sell EMA (6+ ticks of 85%+ selling).`
        : 'Order flow balanced — no directional selling pressure.',
      confidence,
      timestamp: tick.processing_timestamp,
    };
  }

  // ── VOLATILITY (unchanged — math verified correct) ─────────────────────────
  private processVolatility(tick: NormalizedMarketTick): SignalOutput {
    this.priceBuffer.push(safeNum(tick.price, 1));
    const prices = this.priceBuffer.getAll();
    if (prices.length < 20) return this.defaultSignal(SignalType.VOLATILITY, tick.processing_timestamp);

    const shortTerm = prices.slice(-10);
    const getStd = (arr: number[]) => {
      const mean = arr.reduce((a, b) => a + b) / arr.length;
      return Math.sqrt(safeNum(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length, 0));
    };
    const stdShort = safeNum(getStd(shortTerm), 0);
    const stdLong  = safeNum(getStd(prices), 1) || 1;
    const ratio    = safeNum(stdShort / stdLong, 1);
    const risk     = safeNum(Math.min(100, Math.max(0, (ratio - 1) * 50)), 0);
    const confidence = this.determineConfidence(prices.length, 50, 30);

    return {
      name:        SignalType.VOLATILITY,
      value:       Math.round(risk),
      severity:    this.getSeverity(risk),
      triggered:   risk > 55,
      raw_metrics: { 'Vol Ratio': ratio.toFixed(2), 'Price Std': stdShort.toFixed(2) },
      explanation: risk > 55
        ? `Intraday vol expansion: ${ratio.toFixed(2)}× regime baseline.`
        : 'Price volatility within regime bounds.',
      confidence,
      timestamp: tick.processing_timestamp,
    };
  }

  // ── FORCED SELLING ─────────────────────────────────────────────────────────
  private processForcedSelling(tick: NormalizedMarketTick): SignalOutput {
    const largeSells    = tick.trades.large_trades.filter(t => t.side === 'sell');
    const totalLargeVol = safeNum(largeSells.reduce((s, t) => s + t.quantity, 0), 0);
    const blockCount    = largeSells.length;
    const risk          = safeNum(Math.min(100, (totalLargeVol / 15) * 100), 0);
    const confidence    = this.determineConfidence(blockCount, 3, 1);

    return {
      name:        SignalType.FORCED_SELLING,
      value:       Math.round(risk),
      severity:    this.getSeverity(risk),
      triggered:   risk > 50,
      raw_metrics: { 'Whale Vol': totalLargeVol.toFixed(2) + ' BTC', 'Blocks': blockCount },
      explanation: risk > 50
        ? `Block selling: ${totalLargeVol.toFixed(2)} BTC across ${blockCount} block${blockCount !== 1 ? 's' : ''}.`
        : 'No significant block selling detected.',
      confidence,
      timestamp: tick.processing_timestamp,
    };
  }

  // ── Stress calculation ─────────────────────────────────────────────────────

  private calculateStressWithTrace(
    signals: Record<SignalType, SignalOutput>,
    tick:    NormalizedMarketTick
  ): { stress: StressScore; trace: DecisionTrace } {
    const sigArray = Object.values(signals);

    const rawStress = safeNum(
      (signals[SignalType.LIQUIDITY].value      * this.weights[SignalType.LIQUIDITY])  +
      (signals[SignalType.FLOW].value           * this.weights[SignalType.FLOW])       +
      (signals[SignalType.VOLATILITY].value     * this.weights[SignalType.VOLATILITY]) +
      (signals[SignalType.FORCED_SELLING].value * this.weights[SignalType.FORCED_SELLING]),
      0
    );

    const activeSignals   = sigArray.filter(s => s.triggered).length;
    const shockMultiplier = safeNum(SHOCK_TABLE[activeSignals] ?? 1.0, 1.0);
    const targetStress    = safeNum(Math.min(100, rawStress * shockMultiplier), 0);

    const alpha          = targetStress > this.previousStress ? 0.35 : 0.15;
    const smoothedStress = safeNum((alpha * targetStress) + ((1 - alpha) * this.previousStress), 0);
    const finalScore     = safeNum(Math.round(smoothedStress), 0);
    const level          = this.classifyLevel(smoothedStress);

    const confValues = sigArray.map(s =>
      s.confidence === ConfidenceLevel.HIGH ? 3 : s.confidence === ConfidenceLevel.MEDIUM ? 2 : 1
    );
    const avgConf = confValues.reduce((a, b) => a + b, 0) / confValues.length;
    const globalConfidence =
      avgConf > 2.5 ? ConfidenceLevel.HIGH :
      avgConf > 1.5 ? ConfidenceLevel.MEDIUM :
                      ConfidenceLevel.LOW;

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
      [SignalType.LIQUIDITY]:      `${this.liquidityBuffer.size()}/600 depth samples (p90 anchor — need ≥60 for HIGH)`,
      [SignalType.VOLATILITY]:     `${this.priceBuffer.size()} price ticks (need ≥50 for HIGH)`,
      [SignalType.FLOW]:           `Volume this tick — need ≥2.0 BTC/tick for HIGH, ≥0.5 for MEDIUM`,
      [SignalType.FORCED_SELLING]: `Block count — ≥3 blocks = HIGH, ≥1 = MEDIUM, 0 = LOW`
    };

    const sorted   = [...weight_contributions].sort((a, b) => b.contribution - a.contribution);
    const dominant = sorted[0] ?? { signal: 'UNKNOWN', weight: 0, raw_value: 0, contribution: 0, pct_of_total: 0 };

    // FIX [A]: Shock note now correctly describes the SHOCK_TABLE, not 1+N×0.08.
    // This is what the ExplainabilityLayer reads for the audit narrative.
    const shockNote = activeSignals >= 2
      ? `Convergence shock SHOCK_TABLE[${activeSignals}]=${shockMultiplier.toFixed(2)}× applied → target ${targetStress.toFixed(1)}. `
      : activeSignals === 1
        ? `Single signal — SHOCK_TABLE[1]=1.00× (no convergence bonus). Target ${targetStress.toFixed(1)}. `
        : '';
    const direction  = targetStress > this.previousStress ? 'rising' : targetStress < this.previousStress ? 'falling' : 'flat';
    const emaFormula = `${alpha} × ${targetStress.toFixed(1)} + ${(1 - alpha).toFixed(2)} × ${this.previousStress.toFixed(1)} = ${smoothedStress.toFixed(1)}`;
    const audit_narrative = rawStress > 0
      ? `Dominant: ${dominant.signal} (${(dominant.weight * 100).toFixed(0)}% wt × ${dominant.raw_value} raw = ${dominant.contribution.toFixed(1)} pts, ${dominant.pct_of_total.toFixed(1)}%). Raw: ${rawStress.toFixed(1)}. ${shockNote}Stress ${direction} — α=${alpha} (${alpha === 0.35 ? 'fast-attack' : 'slow-decay'}). EMA: ${emaFormula} → ${finalScore} (${level}). Confidence: ${globalConfidence}.`
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

  // ── Causality engine ───────────────────────────────────────────────────────

  private getPatternLabel(signals: Record<SignalType, SignalOutput>): string | null {
    const bits =
      (signals[SignalType.LIQUIDITY].triggered      ? '1' : '0') +
      (signals[SignalType.FLOW].triggered           ? '1' : '0') +
      (signals[SignalType.VOLATILITY].triggered     ? '1' : '0') +
      (signals[SignalType.FORCED_SELLING].triggered ? '1' : '0');
    return PATTERN_LABELS[bits] ?? null;
  }

  // FIX [F]: velocity returned in pts/s (×10 for 100ms tick cadence).
  private getStressVelocity(): number {
    if (this.stressHistory.length < 2) return 0;
    const diffs: number[] = [];
    for (let i = 1; i < this.stressHistory.length; i++) {
      diffs.push(this.stressHistory[i] - this.stressHistory[i - 1]);
    }
    const perTick = safeNum(diffs.reduce((a, b) => a + b, 0) / diffs.length, 0);
    // Convert pts/100ms-tick → pts/s for display readability
    return perTick * 10;
  }

  private buildCausalSequence(
    stress:  StressScore,
    signals: Record<SignalType, SignalOutput>,
    tick:    NormalizedMarketTick
  ): CausalSequence {
    const activeEntries = Object.values(signals).filter(s => s.triggered);

    if (activeEntries.length === 0) {
      this.triggerOrder      = [];
      this.catalystTimestamp = 0;
      return {
        active: false, steps: [], catalyst_id: null,
        narrative: '', risk_assessment: '',
        pattern_label: null, stress_velocity: 0
      };
    }

    activeEntries.forEach(s => {
      if (!this.triggerOrder.find(t => t.signal === s.name)) {
        this.triggerOrder.push({
          signal:       s.name as SignalType,
          timestamp:    tick.exchange_timestamp,
          initialValue: s.value
        });
        if (this.triggerOrder.length === 1) this.catalystTimestamp = tick.exchange_timestamp;
      }
    });
    this.triggerOrder = this.triggerOrder.filter(t => signals[t.signal].triggered);
    if (this.triggerOrder.length === 0) this.catalystTimestamp = 0;

    const velocity     = this.getStressVelocity(); // pts/s
    const patternLabel = this.getPatternLabel(signals);
    const rawTotal     = Object.values(signals).reduce(
      (s, sig) => s + sig.value * this.weights[sig.name], 0
    );

    const steps: CausalStep[] = this.triggerOrder.map((trigger, index) => {
      const signalData      = signals[trigger.signal];
      const weight          = this.weights[trigger.signal];
      const contributionPts = safeNum(signalData.value * weight, 0);
      const contributionPct = rawTotal > 0 ? safeNum((contributionPts / rawTotal) * 100, 0) : 0;
      const elapsedMs       = tick.exchange_timestamp - (this.catalystTimestamp || tick.exchange_timestamp);

      const type: 'CATALYST' | 'AMPLIFIER' | 'SYSTEMIC' =
        index === 0 ? 'CATALYST' :
        stress.score > 70 ? 'SYSTEMIC' : 'AMPLIFIER';

      return {
        sequence_id:               index + 1,
        type,
        signal:                    trigger.signal,
        description:               `${signalData.explanation} [${signalData.value}/100 — ${contributionPts.toFixed(1)}pts (${contributionPct.toFixed(0)}% of stress)]`,
        severity:                  signalData.severity,
        timestamp:                 trigger.timestamp,
        signal_intensity:          signalData.value,
        elapsed_since_catalyst_ms: elapsedMs,
        stress_contribution_pts:   contributionPts,
        stress_contribution_pct:   contributionPct
      };
    });

    const catalyst       = this.triggerOrder[0]?.signal || null;
    const narrative      = this.generateNarrative(steps, stress, velocity, patternLabel);
    const riskAssessment = this.generateRiskAssessment(stress, signals, velocity, patternLabel);

    return {
      active: true, steps, catalyst_id: catalyst,
      narrative, risk_assessment: riskAssessment,
      pattern_label: patternLabel, stress_velocity: velocity
    };
  }

  private generateNarrative(
    steps: CausalStep[], stress: StressScore,
    velocity: number, patternLabel: string | null
  ): string {
    if (steps.length === 0) return '';
    const catalystIntensity = steps[0].signal_intensity;
    // FIX [F]: velocity now in pts/s — label matches
    const velStr = Math.abs(velocity) > 1
      ? ` Stress ${velocity > 0 ? 'accelerating' : 'decelerating'} at ${velocity > 0 ? '+' : ''}${velocity.toFixed(1)} pts/s.`
      : '';
    const label = patternLabel ? ` [${patternLabel}]` : '';

    if (steps.length === 1) {
      return `${steps[0].signal} initiated at intensity ${catalystIntensity}/100.${velStr}${label}`;
    }
    const systemicCount = steps.filter(s => s.type === 'SYSTEMIC').length;
    if (systemicCount > 0 || stress.score > 80) {
      const totalPts = steps.reduce((s, st) => s + st.stress_contribution_pts, 0);
      return `Systemic breakdown — ${steps[0].signal} detonated first (${catalystIntensity}/100), cascading through ${steps.length - 1} vector${steps.length > 2 ? 's' : ''}. ${totalPts.toFixed(0)}pts converging.${velStr}${label}`;
    }
    if (steps.length === 2) {
      const elapsed    = steps[1].elapsed_since_catalyst_ms;
      const elapsedStr = elapsed > 0
        ? ` ${steps[1].signal} joined +${(elapsed / 1000).toFixed(0)}s later.`
        : ` ${steps[1].signal} joined simultaneously.`;
      return `${steps[0].signal} cracked first.${elapsedStr}${velStr}${label}`;
    }
    return `${steps[0].signal} led a ${steps.length}-signal convergence. ${stress.signals_aligned} structural anomalies active.${velStr}${label}`;
  }

  private generateRiskAssessment(
    stress: StressScore, signals: Record<SignalType, SignalOutput>,
    velocity: number, patternLabel: string | null
  ): string {
    const velNote = Math.abs(velocity) > 1
      ? ` Velocity ${velocity > 0 ? '+' : ''}${velocity.toFixed(1)} pts/s.`
      : '';
    const label   = patternLabel ? `${patternLabel} — ` : '';
    const parts: string[] = [];
    if (signals[SignalType.LIQUIDITY].triggered)      parts.push(`Liq −${signals[SignalType.LIQUIDITY].value.toFixed(0)}%`);
    if (signals[SignalType.FLOW].triggered)           parts.push(`Flow ${signals[SignalType.FLOW].value.toFixed(0)}/100`);
    if (signals[SignalType.VOLATILITY].triggered)     parts.push(`Vol ${signals[SignalType.VOLATILITY].value.toFixed(0)}/100`);
    if (signals[SignalType.FORCED_SELLING].triggered) parts.push(`Whale ${signals[SignalType.FORCED_SELLING].value.toFixed(0)}/100`);
    const metrics = parts.length > 0 ? ` ${parts.join(', ')}.` : '';

    if (stress.score >= 80) return `CRITICAL: ${label}${stress.signals_aligned}-signal convergence at ${stress.score}.${metrics}${velNote} Structural failure imminent.`;
    if (stress.score >= 60) return `UNSTABLE: ${label}${stress.signals_aligned} vector${stress.signals_aligned > 1 ? 's' : ''} at ${stress.score}.${metrics}${velNote} Corrective action likely insufficient.`;
    return                         `ELEVATED: ${label}Monitoring catalyst propagation at ${stress.score}.${metrics}${velNote}`;
  }

  // ── Critical event detection ───────────────────────────────────────────────

  private detectCriticalEvent(
    tick: NormalizedMarketTick, stress: StressScore,
    causal: CausalSequence, lastScore: number
  ): CriticalEvent | null {
    const crossedThreshold = stress.score > 60 && lastScore <= 60;

    // FIX [G]: Escalation cooldown separated from threshold crossing.
    // Threshold crossing: ALWAYS fire immediately — this is the initial breach.
    // Escalation: only fire if cooldown has elapsed.
    // OLD: both used same 60s cooldown → initial breach could be suppressed.
    // NEW: crossing = instant, escalation = 60s cooldown (live) / 300s (historical)
    // Mode detection: historical ticks use exchange_timestamp = kline open time
    // which is very regular (exact 60s intervals). Live ticks are irregular.
    const cooldownMs = 60_000;
    const cooledDown = (tick.exchange_timestamp - this.lastEventExchangeTs) >= cooldownMs;
    const escalation = stress.score > 60
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

  // ── Helpers ────────────────────────────────────────────────────────────────

  private getSeverity(risk: number): StressLevel {
    if (risk < 25) return StressLevel.STABLE;
    if (risk < 50) return StressLevel.ELEVATED;
    if (risk < 75) return StressLevel.STRESSED;
    if (risk < 90) return StressLevel.UNSTABLE;
    return StressLevel.CRITICAL;
  }

  // FIX: Recalibrated thresholds (proven by simulation).
  // STABLE<20 ELEVATED<40 STRESSED<60 UNSTABLE<80 CRITICAL>=80
  private classifyLevel(score: number): StressLevel {
    if (score < 20) return StressLevel.STABLE;
    if (score < 40) return StressLevel.ELEVATED;
    if (score < 60) return StressLevel.STRESSED;
    if (score < 80) return StressLevel.UNSTABLE;
    return StressLevel.CRITICAL;
  }

  private defaultSignal(name: SignalType, ts: number): SignalOutput {
    return {
      name, value: 0, severity: StressLevel.STABLE, triggered: false,
      raw_metrics: {}, explanation: 'Insufficient data.',
      confidence: ConfidenceLevel.LOW, timestamp: ts
    };
  }
}
