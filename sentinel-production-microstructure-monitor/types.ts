
export enum StressLevel {
  STABLE   = 'STABLE',
  ELEVATED = 'ELEVATED',
  STRESSED = 'STRESSED',
  UNSTABLE = 'UNSTABLE',
  CRITICAL = 'CRITICAL'
}

export enum ConfidenceLevel {
  LOW    = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH   = 'HIGH'
}

export enum SignalType {
  LIQUIDITY      = 'Liquidity Fragility',
  FLOW           = 'Order Flow Imbalance',
  VOLATILITY     = 'Volatility Regime Shift',
  FORCED_SELLING = 'Forced Selling'
}

export interface Trade {
  id:        number;
  price:     number;
  quantity:  number;
  timestamp: number;
  side:      'buy' | 'sell';
}

export interface SignalOutput {
  name:        SignalType;
  value:       number;
  severity:    StressLevel;
  triggered:   boolean;
  raw_metrics: Record<string, number | string>;
  explanation: string;
  confidence:  ConfidenceLevel;
  timestamp:   number;
}

export interface StressScore {
  score:           number;
  raw_score:       number;
  level:           StressLevel;
  color:           string;
  signals_aligned: number;
  confidence:      ConfidenceLevel;
  breakdown:       Record<string, number>;
  timestamp:       number;
}

export interface CausalStep {
  sequence_id: number;
  type:        'CATALYST' | 'AMPLIFIER' | 'SYSTEMIC';
  signal:      SignalType;
  description: string;
  severity:    StressLevel;
  timestamp:   number;
  // Optional enrichment fields — set by advanced engine builds, safe to omit
  signal_intensity?:          number;
  elapsed_since_catalyst_ms?: number;
  stress_contribution_pts?:   number;
  stress_contribution_pct?:   number;
}

export interface CausalSequence {
  active:          boolean;
  steps:           CausalStep[];
  catalyst_id:     SignalType | null;
  narrative:       string;
  risk_assessment: string;
  // Optional enrichment fields — set by advanced engine builds, safe to omit
  pattern_label?:   string | null;
  stress_velocity?: number;
}

// Full market state captured at the moment a critical event fires.
// Used by the Snapshot feature to freeze the UI to that exact moment.
export interface MarketSnapshot {
  stress:            StressScore;
  signals:           Record<SignalType, SignalOutput>;
  causal:            CausalSequence;
  trace:             DecisionTrace;
  tick:              NormalizedMarketTick;
  timelineAtCapture: TimelineDataPoint[];
}

export interface CriticalEvent {
  id:             string;
  timestamp:      number;
  price:          number;
  stress_score:   number;
  level:          StressLevel;
  primary_factor: SignalType | string;
  narrative:      string;
  signals:        SignalType[];
  // Attached by App.tsx when the event is logged — not set by AnalyticsEngine
  snapshot?:      MarketSnapshot;
}

export interface NormalizedMarketTick {
  exchange_timestamp:   number;
  received_timestamp:   number;
  processing_timestamp: number;
  price:        number;
  volume_24h:   number;
  bids:         [number, number][];
  asks:         [number, number][];
  trades: {
    buy_volume:   number;
    sell_volume:  number;
    buy_count:    number;
    sell_count:   number;
    large_trades: Trade[];
  };
  mid_price:    number;
  spread:       number;
  spread_bps:   number;
  total_depth:  number;
  is_valid:     boolean;
  data_quality: 'GOOD' | 'DEGRADED' | 'STALE';
}

export interface TimelineDataPoint {
  timestamp:        number;
  price:            number;
  stress:           number;
  pointOfNoReturn?: boolean;
  label?:           string | null;
}

export interface WeightContribution {
  signal:       string;
  weight:       number;
  raw_value:    number;
  contribution: number;
  pct_of_total: number;
}

export interface DecisionTrace {
  weight_contributions: WeightContribution[];
  raw_score:            number;
  signals_aligned:      number;
  shock_multiplier:     number;
  pre_smooth_score:     number;
  smoothing_alpha:      number;
  previous_score:       number;
  final_score:          number;
  confidence_reasons:   Record<string, string>;
  audit_narrative:      string;
  timestamp:            number;
}
