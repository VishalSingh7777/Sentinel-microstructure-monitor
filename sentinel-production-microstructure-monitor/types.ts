
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
  score:            number;
  raw_score:        number;
  level:            StressLevel;
  color:            string;
  signals_aligned:  number;
  confidence:       ConfidenceLevel;
  breakdown:        Record<string, number>;
  timestamp:        number;
}

export interface CausalStep {
  sequence_id:                number;
  type:                       'CATALYST' | 'AMPLIFIER' | 'SYSTEMIC';
  signal:                     SignalType;
  description:                string;
  severity:                   StressLevel;
  timestamp:                  number;
  // NEW: how loud this signal is (0-100 raw value)
  signal_intensity:           number;
  // NEW: how many ms have elapsed since the CATALYST first fired
  elapsed_since_catalyst_ms:  number;
  // NEW: this signal's weighted contribution to total stress (pts, not %)
  stress_contribution_pts:    number;
  // NEW: this signal's share of the weighted total (0-100 %)
  stress_contribution_pct:    number;
}

export interface CausalSequence {
  active:           boolean;
  steps:            CausalStep[];
  catalyst_id:      SignalType | null;
  narrative:        string;
  risk_assessment:  string;
  // NEW: named structural pattern based on which signals are co-active
  pattern_label:    string | null;
  // NEW: average stress change per tick over last 5 ticks (+ve = rising)
  stress_velocity:  number;
}

export interface TimelineDataPoint {
  timestamp:       number;
  price:           number;
  stress:          number;
  pointOfNoReturn?: boolean;
  label?:          string | null;
}

// A complete market state captured at the moment a critical event fires.
// Used by the Snapshot feature so any breach log entry can freeze the UI
// to show exactly what the market looked like when that event occurred.
export interface MarketSnapshot {
  stress:             StressScore;
  signals:            Record<SignalType, SignalOutput>;
  causal:             CausalSequence;
  trace:              DecisionTrace;
  tick:               NormalizedMarketTick;
  // last 100 timeline points up to (and including) the capture moment
  timelineAtCapture:  TimelineDataPoint[];
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
  // snapshot is attached by App.tsx when the event is logged
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
