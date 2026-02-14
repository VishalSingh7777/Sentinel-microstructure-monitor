
import { 
  NormalizedMarketTick, SignalOutput, StressLevel, ConfidenceLevel, 
  SignalType, StressScore, CausalSequence, CausalStep, Trade, CriticalEvent,
  WeightContribution, DecisionTrace
} from '../types';
import { THEME } from '../constants';
import { CircularBuffer } from './CircularBuffer';

export class AnalyticsEngine {
  private liquidityBuffer = new CircularBuffer<number>(300);
  private priceBuffer = new CircularBuffer<number>(300);
  private volBuffer = new CircularBuffer<number>(60);
  private previousStress = 0;
  private previousLevel: StressLevel = StressLevel.STABLE;
  private previousSignalsAligned = 0;
  private lastTrace: DecisionTrace | null = null;
  
  private triggerOrder: { signal: SignalType, timestamp: number, initialValue: number }[] = [];
  
  private readonly weights = {
    [SignalType.LIQUIDITY]: 0.35,
    [SignalType.FLOW]: 0.25,
    [SignalType.VOLATILITY]: 0.25,
    [SignalType.FORCED_SELLING]: 0.15
  };

  reset(): void {
    this.liquidityBuffer.clear();
    this.priceBuffer.clear();
    this.volBuffer.clear();
    this.previousStress = 0;
    this.previousLevel = StressLevel.STABLE;
    this.previousSignalsAligned = 0;
    this.triggerOrder = [];
    this.lastTrace = null;
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
    const causal = this.buildCausalSequence(stress, signals);
    const criticalEvent = this.detectCriticalEvent(tick, stress, causal);

    return { signals, stress, causal, criticalEvent, trace };
  }

  private determineConfidence(value: number, highThreshold: number, medThreshold: number): ConfidenceLevel {
    if (value >= highThreshold) return ConfidenceLevel.HIGH;
    if (value >= medThreshold) return ConfidenceLevel.MEDIUM;
    return ConfidenceLevel.LOW;
  }

  private processLiquidity(tick: NormalizedMarketTick): SignalOutput {
    this.liquidityBuffer.push(tick.total_depth);
    const baseline = this.liquidityBuffer.mean();
    const depthChange = baseline === 0 ? 0 : ((tick.total_depth - baseline) / baseline) * 100;
    let risk = depthChange >= 0 ? 0 : Math.min(100, (-depthChange / 40) * 100);
    
    const confidence = this.determineConfidence(this.liquidityBuffer.size(), 60, 20);

    return {
      name: SignalType.LIQUIDITY,
      value: Math.round(risk),
      severity: this.getSeverity(risk),
      triggered: risk > 60,
      raw_metrics: { 'Depth': tick.total_depth.toFixed(1), 'Δ Mean': `${depthChange.toFixed(1)}%` },
      explanation: risk > 60 ? `Liquidity hole: ${Math.abs(depthChange).toFixed(1)}% below baseline.` : 'Depth within stable range.',
      confidence: confidence,
      timestamp: tick.processing_timestamp
    };
  }

  private processFlow(tick: NormalizedMarketTick): SignalOutput {
    const totalVol = tick.trades.buy_volume + tick.trades.sell_volume;
    if (totalVol === 0) return this.defaultSignal(SignalType.FLOW, tick.processing_timestamp);
    
    const sellRatio = tick.trades.sell_volume / totalVol;
    const risk = Math.max(0, (sellRatio - 0.5) * 200);

    const confidence = this.determineConfidence(totalVol, 2.0, 0.5);

    return {
      name: SignalType.FLOW,
      value: Math.round(risk),
      severity: this.getSeverity(risk),
      triggered: risk > 65,
      raw_metrics: { 'Sell %': (sellRatio * 100).toFixed(1) + '%', 'Imbalance': (sellRatio / (1 - sellRatio || 0.01)).toFixed(2) },
      explanation: risk > 65 ? 'Aggressive market selling detected.' : 'Transaction flow is balanced.',
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
    const stdLong = getStd(prices) || 1;
    const ratio = stdShort / stdLong;
    const risk = Math.min(100, Math.max(0, (ratio - 1) * 50));

    const confidence = this.determineConfidence(prices.length, 50, 30);

    return {
      name: SignalType.VOLATILITY,
      value: Math.round(risk),
      severity: this.getSeverity(risk),
      triggered: risk > 55,
      raw_metrics: { 'Vol Ratio': ratio.toFixed(2), 'Price Std': stdShort.toFixed(2) },
      explanation: risk > 55 ? 'Price instability detected via volatility expansion.' : 'Price volatility within regime bounds.',
      confidence: confidence,
      timestamp: tick.processing_timestamp
    };
  }

  private processForcedSelling(tick: NormalizedMarketTick): SignalOutput {
    const largeSells = tick.trades.large_trades.filter(t => t.side === 'sell');
    const totalLargeVol = largeSells.reduce((s, t) => s + t.quantity, 0);
    const risk = Math.min(100, (totalLargeVol / 5) * 100);

    const totalTrades = tick.trades.buy_count + tick.trades.sell_count;
    const confidence = this.determineConfidence(totalTrades, 50, 10);

    return {
      name: SignalType.FORCED_SELLING,
      value: Math.round(risk),
      severity: this.getSeverity(risk),
      triggered: risk > 45,
      raw_metrics: { 'Whale Vol': totalLargeVol.toFixed(1), 'Count': largeSells.length },
      explanation: risk > 45 ? `Large seller active: ${totalLargeVol.toFixed(1)} BTC sold in blocks.` : 'No significant whale selling detected.',
      confidence: confidence,
      timestamp: tick.processing_timestamp
    };
  }

  private calculateStressWithTrace(signals: Record<SignalType, SignalOutput>, tick: NormalizedMarketTick): { stress: StressScore, trace: DecisionTrace } {
    const sigArray = Object.values(signals);
    const rawStress = 
      (signals[SignalType.LIQUIDITY].value * this.weights[SignalType.LIQUIDITY]) +
      (signals[SignalType.FLOW].value * this.weights[SignalType.FLOW]) +
      (signals[SignalType.VOLATILITY].value * this.weights[SignalType.VOLATILITY]) +
      (signals[SignalType.FORCED_SELLING].value * this.weights[SignalType.FORCED_SELLING]);
    
    const activeSignals = sigArray.filter(s => s.triggered).length;
    const shockMultiplier = 1.0 + (activeSignals * 0.08); 
    const targetStress = Math.min(100, rawStress * shockMultiplier);

    const alpha = targetStress > this.previousStress ? 0.35 : 0.15;
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
    if (avgConf > 2.5) globalConfidence = ConfidenceLevel.HIGH;
    else if (avgConf > 1.5) globalConfidence = ConfidenceLevel.MEDIUM;

    // Weight Contributions for Trace
    const weight_contributions: WeightContribution[] = sigArray.map(sig => {
      const weight = this.weights[sig.name];
      const contribution = sig.value * weight;
      return {
        signal: sig.name,
        weight: weight,
        raw_value: sig.value,
        contribution: contribution,
        pct_of_total: rawStress > 0 ? (contribution / rawStress) * 100 : 0
      };
    });

    const confidence_reasons: Record<string, string> = {
      [SignalType.LIQUIDITY]: `${this.liquidityBuffer.size()} depth samples (need ≥60 for HIGH)`,
      [SignalType.VOLATILITY]: `${this.priceBuffer.size()} price ticks (need ≥50 for HIGH)`,
      [SignalType.FLOW]: `Based on volume density — need ≥2.0 BTC/s for HIGH`,
      [SignalType.FORCED_SELLING]: `Based on trade frequency — need ≥50 trades for HIGH`
    };

    const dominant = [...weight_contributions].sort((a,b) => b.contribution - a.contribution)[0];
    const audit_narrative = `Dominant contributor: ${dominant.signal} (${(dominant.weight * 100).toFixed(0)}% weight × ${dominant.raw_value} raw = ${dominant.contribution.toFixed(1)} pts, ${dominant.pct_of_total.toFixed(1)}% of raw score). Raw weighted score: ${rawStress.toFixed(1)} pts. ${activeSignals > 0 ? `Shock multiplier ${shockMultiplier.toFixed(2)}× applied because ${activeSignals} signal(s) triggered simultaneously, elevating score to ${targetStress.toFixed(1)}. ` : ''}Stress is ${targetStress > this.previousStress ? 'rising' : 'falling'}, so adaptive smoothing alpha = ${alpha} (${alpha === 0.35 ? 'fast-track — system escalates quickly' : 'slow-decay — system de-escalates conservatively'}). Final score: ${finalScore} (${level}). System confidence: ${globalConfidence}.`;

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
      timestamp: Date.now()
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
      timestamp: Date.now()
    };

    return { stress, trace };
  }

  private buildCausalSequence(stress: StressScore, signals: Record<SignalType, SignalOutput>): CausalSequence {
    const activeSignalEntries = Object.values(signals).filter(s => s.triggered);
    
    if (activeSignalEntries.length === 0) {
      this.triggerOrder = [];
      return { active: false, steps: [], catalyst_id: null, narrative: '', risk_assessment: '' };
    }

    activeSignalEntries.forEach(s => {
      if (!this.triggerOrder.find(t => t.signal === s.name)) {
        this.triggerOrder.push({ signal: s.name as SignalType, timestamp: Date.now(), initialValue: s.value });
      }
    });

    this.triggerOrder = this.triggerOrder.filter(t => signals[t.signal].triggered);

    const steps: CausalStep[] = this.triggerOrder.map((trigger, index) => {
      const signalData = signals[trigger.signal];
      let type: 'CATALYST' | 'AMPLIFIER' | 'SYSTEMIC' = 'AMPLIFIER';
      
      if (index === 0) {
        type = 'CATALYST';
      } else {
        type = stress.score > 70 ? 'SYSTEMIC' : 'AMPLIFIER';
      }

      return {
        sequence_id: index + 1,
        type,
        signal: trigger.signal,
        description: signalData.explanation,
        severity: signalData.severity,
        timestamp: trigger.timestamp
      };
    });

    const catalyst = this.triggerOrder[0]?.signal || null;
    const narrative = this.generateNarrative(steps, stress);

    return {
      active: true,
      steps,
      catalyst_id: catalyst,
      narrative,
      risk_assessment: stress.score > 80 ? 'CRITICAL: Structural failure imminent.' : 
                       stress.score > 60 ? 'UNSTABLE: Corrective action likely insufficient.' :
                       'ELEVATED: Monitoring catalyst propagation.'
    };
  }

  private generateNarrative(steps: CausalStep[], stress: StressScore): string {
    if (steps.length === 0) return '';
    const catalyst = steps[0].signal;
    if (steps.length === 1) return `Event initiated by ${catalyst}.`;
    
    const systemicCount = steps.filter(s => s.type === 'SYSTEMIC').length;
    if (systemicCount > 0) {
      return `Systemic breakdown initiated by ${catalyst}, now exacerbated by ${steps.length - 1} secondary amplifiers.`;
    }
    return `Tension detected in ${catalyst}, causing feedback in ${steps[steps.length - 1].signal}.`;
  }

  private detectCriticalEvent(tick: NormalizedMarketTick, stress: StressScore, causal: CausalSequence): CriticalEvent | null {
    const levelUpgrade = this.getStressRank(stress.level) > this.getStressRank(this.previousLevel) && 
                         this.getStressRank(stress.level) >= 2;
    
    const alignmentIncrease = stress.signals_aligned > this.previousSignalsAligned && 
                              stress.score > 60;

    if (levelUpgrade || alignmentIncrease) {
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

      this.previousLevel = stress.level;
      this.previousSignalsAligned = stress.signals_aligned;
      return event;
    }

    this.previousLevel = stress.level;
    this.previousSignalsAligned = stress.signals_aligned;
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
