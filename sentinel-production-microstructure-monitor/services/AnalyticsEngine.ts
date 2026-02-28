import { 
  NormalizedMarketTick, SignalOutput, StressLevel, ConfidenceLevel, 
  SignalType, StressScore, CausalSequence, CausalStep, Trade, CriticalEvent,
  WeightContribution, DecisionTrace
} from '../types';
import { THEME } from '../constants';
import { CircularBuffer } from './CircularBuffer';

const safeNum = (val: number, fallback = 0): number =>
  isFinite(val) && !isNaN(val) ? val : fallback;

// ─── Named structural failure patterns ────────────────────────────────────────
// Each pattern is named by the specific combination of active signals.
// Ordering: LIQUIDITY, FLOW, VOLATILITY, FORCED_SELLING → bitmask L|F|V|S
const PATTERN_LABELS: Record<string, string> = {
  '1000': 'LIQUIDITY DRAIN',
  '0100': 'SELL PRESSURE',
  '0010': 'PRICE INSTABILITY',
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

export class AnalyticsEngine {
  private liquidityBuffer = new CircularBuffer<number>(300);
  private priceBuffer     = new CircularBuffer<number>(300);
  // NOTE: volBuffer removed — dead code (never pushed to or read from).
  private previousStress          = 0;
  private previousLevel: StressLevel = StressLevel.STABLE;
  private previousSignalsAligned  = 0;
  private lastTrace: DecisionTrace | null = null;
  private previousFlowValue       = 0;
  // Escalation cooldown — 60 s of exchange time between breach log entries
  private lastEventExchangeTs     = 0;
  // Causality tracking
  private triggerOrder: { signal: SignalType, timestamp: number, initialValue: number }[] = [];
  private catalystTimestamp       = 0;    // exchange_timestamp when first signal fired
  // Stress velocity — last 5 smoothed scores for rate-of-change calculation
  private stressHistory: number[] = [];

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
    this.previousFlowValue      = 0;
    this.lastEventExchangeTs    = 0;
    this.catalystTimestamp      = 0;
    this.stressHistory          = [];
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
    // Update velocity history AFTER computing stress so this tick is included
    this.stressHistory.push(stress.score);
    if (this.stressHistory.length > 5) this.stressHistory.shift();

    const causal       = this.buildCausalSequence(stress, signals, tick);
    const criticalEvent = this.detectCriticalEvent(tick, stress, causal, trace.previous_score);

    return { signals, stress, causal, criticalEvent, trace };
  }

  // ── Signal processors ──────────────────────────────────────────────────────

  private determineConfidence(value: number, highThreshold: number, medThreshold: number): ConfidenceLevel {
    if (value >= highThreshold) return ConfidenceLevel.HIGH;
    if (value >= medThreshold)  return ConfidenceLevel.MEDIUM;
    return ConfidenceLevel.LOW;
  }

  private processLiquidity(tick: NormalizedMarketTick): SignalOutput {
    this.liquidityBuffer.push(safeNum(tick.total_depth, 0.1));
    const baseline    = safeNum(this.liquidityBuffer.mean(), 0.1);
    const depthChange = baseline === 0
      ? 0
      : safeNum(((tick.total_depth - baseline) / baseline) * 100, 0);
    let risk = depthChange >= 0 ? 0 : Math.min(100, (-depthChange / 40) * 100);
    risk     = safeNum(risk, 0);
    const confidence = this.determineConfidence(this.liquidityBuffer.size(), 60, 20);
    return {
      name: SignalType.LIQUIDITY,
      value: Math.round(risk),
      severity: this.getSeverity(risk),
      triggered: risk > 60,
      raw_metrics: { 'Depth': safeNum(tick.total_depth).toFixed(1), 'Δ Mean': `${safeNum(depthChange).toFixed(1)}%` },
      explanation: risk > 60
        ? `Liquidity hole: ${Math.abs(depthChange).toFixed(1)}% below baseline.`
        : 'Depth within stable range.',
      confidence,
      timestamp: tick.processing_timestamp
    };
  }

  private processFlow(tick: NormalizedMarketTick): SignalOutput {
    const totalVol = safeNum(tick.trades.buy_volume + tick.trades.sell_volume, 0);
    if (totalVol === 0) {
      const prev = this.previousFlowValue;
      return {
        name: SignalType.FLOW,
        value: Math.round(prev),
        severity: this.getSeverity(prev),
        triggered: prev > 65,
        raw_metrics: { 'Sell %': '50.0%', 'Imbalance': '1.00' },
        explanation: prev > 65 ? 'Aggressive market selling detected.' : 'Transaction flow is balanced.',
        confidence: this.determineConfidence(prev > 0 ? 1 : 0, 2.0, 0.5),
        timestamp: tick.processing_timestamp,
      };
    }
    const sellRatio = safeNum(tick.trades.sell_volume / totalVol, 0.5);
    const risk      = safeNum(Math.max(0, (sellRatio - 0.5) * 200), 0);
    this.previousFlowValue = risk;
    const confidence = this.determineConfidence(totalVol, 2.0, 0.5);
    return {
      name: SignalType.FLOW,
      value: Math.round(risk),
      severity: this.getSeverity(risk),
      triggered: risk > 65,
      raw_metrics: {
        'Sell %':    (sellRatio * 100).toFixed(1) + '%',
        'Imbalance': safeNum(sellRatio / (1 - sellRatio || 0.01), 1).toFixed(2)
      },
      explanation: risk > 65 ? 'Aggressive market selling detected.' : 'Transaction flow is balanced.',
      confidence,
      timestamp: tick.processing_timestamp
    };
  }

  // ── VOLATILITY REGIME SHIFT — DO NOT MODIFY ────────────────────────────────
  // Logic: stdShort (last 10 prices) / stdLong (up to 300 prices).
  // Ratio approach is scale-invariant — BTC at any price level cancels perfectly.
  // ratio=1 → risk=0, ratio≥3 → risk=100. Trigger at risk>55 (ratio>2.1) is
  // deliberately conservative — detects genuine regime shifts, not noise.
  // Verified correct 2025-02-28. Do not change.
  private processVolatility(tick: NormalizedMarketTick): SignalOutput {
    this.priceBuffer.push(safeNum(tick.price, 1));
    const prices = this.priceBuffer.getAll();
    if (prices.length < 20) return this.defaultSignal(SignalType.VOLATILITY, tick.processing_timestamp);

    const shortTerm = prices.slice(-10);
    const getStd = (arr: number[]) => {
      const mean = arr.reduce((a, b) => a + b) / arr.length;
      return Math.sqrt(safeNum(arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / arr.length, 0));
    };
    const stdShort = safeNum(getStd(shortTerm), 0);
    const stdLong  = safeNum(getStd(prices), 1) || 1;
    const ratio    = safeNum(stdShort / stdLong, 1);
    const risk     = safeNum(Math.min(100, Math.max(0, (ratio - 1) * 50)), 0);
    const confidence = this.determineConfidence(prices.length, 50, 30);
    return {
      name: SignalType.VOLATILITY,
      value: Math.round(risk),
      severity: this.getSeverity(risk),
      triggered: risk > 55,
      raw_metrics: { 'Vol Ratio': ratio.toFixed(2), 'Price Std': stdShort.toFixed(2) },
      explanation: risk > 55
        ? 'Price instability detected via volatility expansion.'
        : 'Price volatility within regime bounds.',
      confidence,
      timestamp: tick.processing_timestamp
    };
  }
  // ──────────────────────────────────────────────────────────────────────────

  private processForcedSelling(tick: NormalizedMarketTick): SignalOutput {
    const largeSells    = tick.trades.large_trades.filter(t => t.side === 'sell');
    const totalLargeVol = safeNum(largeSells.reduce((s, t) => s + t.quantity, 0), 0);
    // Denominator 10 BTC: gives meaningful 0-100 range for real block sizes.
    // Old denominator was 5 BTC — single 5 BTC block instantly pegged signal at 100.
    const risk       = safeNum(Math.min(100, (totalLargeVol / 10) * 100), 0);
    const blockCount = largeSells.length;
    // Confidence based on block count — this is a block-trade signal, not total trade count
    const confidence = this.determineConfidence(blockCount, 3, 1);
    return {
      name: SignalType.FORCED_SELLING,
      value: Math.round(risk),
      severity: this.getSeverity(risk),
      triggered: risk > 45,
      raw_metrics: { 'Whale Vol': totalLargeVol.toFixed(1), 'Blocks': blockCount },
      explanation: risk > 45
        ? `Large seller active: ${totalLargeVol.toFixed(1)} BTC in ${blockCount} block${blockCount !== 1 ? 's' : ''}.`
        : 'No significant whale selling detected.',
      confidence,
      timestamp: tick.processing_timestamp
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
      [SignalType.LIQUIDITY]:      `${this.liquidityBuffer.size()} depth samples (need ≥60 for HIGH)`,
      [SignalType.VOLATILITY]:     `${this.priceBuffer.size()} price ticks (need ≥50 for HIGH)`,
      [SignalType.FLOW]:           `Volume this tick — need ≥2.0 BTC/tick for HIGH, ≥0.5 for MEDIUM`,
      [SignalType.FORCED_SELLING]: `Block count — ≥3 blocks=HIGH, ≥1=MEDIUM, 0=LOW`
    };

    const sorted   = [...weight_contributions].sort((a, b) => b.contribution - a.contribution);
    const dominant = sorted[0] ?? { signal: 'UNKNOWN', weight: 0, raw_value: 0, contribution: 0, pct_of_total: 0 };
    const shockNote = activeSignals > 0
      ? `Shock multiplier ${shockMultiplier.toFixed(2)}× (${activeSignals} signals active), elevating to ${targetStress.toFixed(1)}. `
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

    this.previousStress = safeNum(smoothedStress, this.previousStress);
    this.lastTrace = trace;

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
    const L = signals[SignalType.LIQUIDITY].triggered      ? '1' : '0';
    const F = signals[SignalType.FLOW].triggered           ? '1' : '0';
    const V = signals[SignalType.VOLATILITY].triggered     ? '1' : '0';
    const S = signals[SignalType.FORCED_SELLING].triggered ? '1' : '0';
    const key = L + F + V + S;
    return PATTERN_LABELS[key] ?? null;
  }

  private getStressVelocity(): number {
    if (this.stressHistory.length < 2) return 0;
    // Average change per tick over the last 5 observations
    const diffs: number[] = [];
    for (let i = 1; i < this.stressHistory.length; i++) {
      diffs.push(this.stressHistory[i] - this.stressHistory[i - 1]);
    }
    return safeNum(diffs.reduce((a, b) => a + b, 0) / diffs.length, 0);
  }

  private buildCausalSequence(
    stress:  StressScore,
    signals: Record<SignalType, SignalOutput>,
    tick:    NormalizedMarketTick
  ): CausalSequence {
    const activeSignalEntries = Object.values(signals).filter(s => s.triggered);

    if (activeSignalEntries.length === 0) {
      this.triggerOrder      = [];
      this.catalystTimestamp = 0;
      return {
        active: false, steps: [], catalyst_id: null,
        narrative: '', risk_assessment: '',
        pattern_label: null, stress_velocity: 0
      };
    }

    // Register newly triggered signals in order — use exchange_timestamp
    // (not Date.now()) so times are meaningful in historical replay mode.
    activeSignalEntries.forEach(s => {
      if (!this.triggerOrder.find(t => t.signal === s.name)) {
        this.triggerOrder.push({
          signal:       s.name as SignalType,
          timestamp:    tick.exchange_timestamp,
          initialValue: s.value
        });
        // Record catalyst timestamp when the FIRST signal fires
        if (this.triggerOrder.length === 1) {
          this.catalystTimestamp = tick.exchange_timestamp;
        }
      }
    });

    // Remove signals that are no longer triggered
    this.triggerOrder = this.triggerOrder.filter(t => signals[t.signal].triggered);
    if (this.triggerOrder.length === 0) this.catalystTimestamp = 0;

    const velocity      = this.getStressVelocity();
    const patternLabel  = this.getPatternLabel(signals);
    const rawTotal      = Object.values(signals).reduce(
      (s, sig) => s + sig.value * this.weights[sig.name], 0
    );

    const steps: CausalStep[] = this.triggerOrder.map((trigger, index) => {
      const signalData         = signals[trigger.signal];
      const weight             = this.weights[trigger.signal];
      const contributionPts    = safeNum(signalData.value * weight, 0);
      const contributionPct    = rawTotal > 0 ? safeNum((contributionPts / rawTotal) * 100, 0) : 0;
      const elapsedMs          = tick.exchange_timestamp - (this.catalystTimestamp || tick.exchange_timestamp);

      const type: 'CATALYST' | 'AMPLIFIER' | 'SYSTEMIC' =
        index === 0 ? 'CATALYST' :
        stress.score > 70 ? 'SYSTEMIC' : 'AMPLIFIER';

      // Rich description: signal explanation + magnitude contribution
      const description = `${signalData.explanation} [intensity ${signalData.value}/100 — contributing ${contributionPts.toFixed(1)}pts (${contributionPct.toFixed(0)}% of stress)]`;

      return {
        sequence_id:               index + 1,
        type,
        signal:                    trigger.signal,
        description,
        severity:                  signalData.severity,
        timestamp:                 trigger.timestamp,
        signal_intensity:          signalData.value,
        elapsed_since_catalyst_ms: elapsedMs,
        stress_contribution_pts:   contributionPts,
        stress_contribution_pct:   contributionPct
      };
    });

    const catalyst  = this.triggerOrder[0]?.signal || null;
    const narrative = this.generateNarrative(steps, stress, velocity, patternLabel);
    const riskAssessment = this.generateRiskAssessment(stress, signals, velocity, patternLabel);

    return {
      active: true,
      steps,
      catalyst_id:    catalyst,
      narrative,
      risk_assessment: riskAssessment,
      pattern_label:  patternLabel,
      stress_velocity: safeNum(velocity, 0)
    };
  }

  private generateNarrative(
    steps:        CausalStep[],
    stress:       StressScore,
    velocity:     number,
    patternLabel: string | null
  ): string {
    if (steps.length === 0) return '';

    const catalystSignal = steps[0].signal;
    const catalystIntensity = steps[0].signal_intensity;
    const velStr = Math.abs(velocity) > 0.5
      ? ` Stress ${velocity > 0 ? 'accelerating' : 'decelerating'} at ${velocity > 0 ? '+' : ''}${velocity.toFixed(1)}pts/tick.`
      : '';
    const label = patternLabel ? ` [${patternLabel}]` : '';

    if (steps.length === 1) {
      return `${catalystSignal} initiated the event at intensity ${catalystIntensity}/100.${velStr}${label}`;
    }

    const latestSignal    = steps[steps.length - 1].signal;
    const secondaryCount  = steps.length - 1;
    const systemicCount   = steps.filter(s => s.type === 'SYSTEMIC').length;

    if (systemicCount > 0 || stress.score > 80) {
      const totalPts = steps.reduce((s, st) => s + st.stress_contribution_pts, 0);
      return `Systemic breakdown — ${catalystSignal} detonated first (${steps[0].signal_intensity}/100), cascading through ${secondaryCount} subsequent vector${secondaryCount > 1 ? 's' : ''}. ${totalPts.toFixed(0)}pts of weighted stress converging.${velStr}${label}`;
    }

    if (steps.length === 2) {
      const elapsed = steps[1].elapsed_since_catalyst_ms;
      const elapsedStr = elapsed > 0
        ? ` ${latestSignal} joined +${(elapsed / 1000).toFixed(0)}s later.`
        : ` ${latestSignal} joined simultaneously.`;
      return `${catalystSignal} cracked first.${elapsedStr}${velStr}${label}`;
    }

    return `${catalystSignal} led a ${steps.length}-signal convergence. ${stress.signals_aligned} structural anomalies active.${velStr}${label}`;
  }

  private generateRiskAssessment(
    stress:       StressScore,
    signals:      Record<SignalType, SignalOutput>,
    velocity:     number,
    patternLabel: string | null
  ): string {
    const liq   = signals[SignalType.LIQUIDITY].value;
    const flow  = signals[SignalType.FLOW].value;
    const vol   = signals[SignalType.VOLATILITY].value;
    const fsell = signals[SignalType.FORCED_SELLING].value;

    const velNote = Math.abs(velocity) > 0.5
      ? ` Rising ${velocity > 0 ? '+' : ''}${velocity.toFixed(1)}pts/tick.`
      : '';

    const label = patternLabel ? `${patternLabel} — ` : '';

    const metricParts: string[] = [];
    if (signals[SignalType.LIQUIDITY].triggered)      metricParts.push(`Depth −${liq.toFixed(0)}%`);
    if (signals[SignalType.FLOW].triggered)           metricParts.push(`Sell flow ${flow.toFixed(0)}/100`);
    if (signals[SignalType.VOLATILITY].triggered)     metricParts.push(`Vol ${vol.toFixed(0)}/100`);
    if (signals[SignalType.FORCED_SELLING].triggered) metricParts.push(`Whale ${fsell.toFixed(0)}/100`);
    const metrics = metricParts.length > 0 ? ` ${metricParts.join(', ')}.` : '';

    if (stress.score > 80) {
      return `CRITICAL: ${label}${stress.signals_aligned}-signal convergence at stress ${stress.score}.${metrics}${velNote} Structural failure imminent.`;
    }
    if (stress.score > 60) {
      return `UNSTABLE: ${label}${stress.signals_aligned} vector${stress.signals_aligned > 1 ? 's' : ''} aligned at stress ${stress.score}.${metrics}${velNote} Corrective action likely insufficient.`;
    }
    return `ELEVATED: ${label}Monitoring catalyst propagation at stress ${stress.score}.${metrics}${velNote}`;
  }

  // ── Critical event detection ───────────────────────────────────────────────

  private detectCriticalEvent(
    tick:      NormalizedMarketTick,
    stress:    StressScore,
    causal:    CausalSequence,
    lastScore: number
  ): CriticalEvent | null {
    const crossedThreshold = stress.score > 60 && lastScore <= 60;
    const cooldownMs       = 60_000;
    const cooledDown       = (tick.exchange_timestamp - this.lastEventExchangeTs) >= cooldownMs;
    const escalation       = stress.score > 60
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
        // snapshot is attached by App.tsx — AnalyticsEngine has no timeline access
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

  // ── Classification helpers ─────────────────────────────────────────────────

  private getSeverity(risk: number): StressLevel {
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
