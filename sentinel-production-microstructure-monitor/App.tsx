import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  NormalizedMarketTick, SignalOutput, StressScore, CausalSequence,
  TimelineDataPoint, SignalType, StressLevel, ConfidenceLevel, CriticalEvent,
  DecisionTrace, MarketSnapshot
} from './types';
import { THEME, TYPOGRAPHY, FORMATTERS } from './constants';
import { BinanceService }    from './services/BinanceService';
import { AnalyticsEngine }   from './services/AnalyticsEngine';
import { AudioEngine }       from './services/AudioEngine';
import { StressGauge }       from './components/StressGauge';
import { SignalCard }         from './components/SignalCard';
import { TimelineChart }      from './components/TimelineChart';
import { HistoricalDataLoader, HistoricalDataPoint } from './services/HistoricalDataLoader';
import { ExplainabilityLayer } from './components/ExplainabilityLayer';

// ── Error Boundary ───────────────────────────────────────────────────────────
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: string }
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: '' };
  }
  static getDerivedStateFromError(error: any) {
    return { hasError: true, error: String(error?.message || error) };
  }
  componentDidCatch(error: any, info: any) {
    console.error('[Sentinel] Caught by ErrorBoundary:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#0a0e14] flex flex-col items-center justify-center gap-6">
          <div className="w-3 h-3 rounded-full bg-red-500 shadow-[0_0_20px_rgba(239,68,68,0.8)]" />
          <div className="flex flex-col items-center gap-3 max-w-md text-center">
            <span className="text-red-400 font-mono text-sm uppercase tracking-[0.3em]">System Error</span>
            <span className="text-gray-600 font-mono text-[10px]">{this.state.error}</span>
            <button
              onClick={() => this.setState({ hasError: false, error: '' })}
              className="mt-4 px-6 py-2 bg-gray-800 text-gray-300 font-mono text-xs rounded border border-gray-700 hover:border-gray-500 transition-all uppercase tracking-widest"
            >
              Reinitialize
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
// ────────────────────────────────────────────────────────────────────────────

const App: React.FC = () => {
  // ── Live state ──────────────────────────────────────────────────────────────
  const [mode, setMode]                     = useState<'LIVE' | 'HISTORICAL'>('LIVE');
  const [lastTick, setLastTick]             = useState<NormalizedMarketTick | null>(null);
  const [signals, setSignals]               = useState<Record<string, SignalOutput> | null>(null);
  const [stress, setStress]                 = useState<StressScore | null>(null);
  const [causal, setCausal]                 = useState<CausalSequence | null>(null);
  const [trace, setTrace]                   = useState<DecisionTrace | null>(null);
  const [criticalLog, setCriticalLog]       = useState<CriticalEvent[]>([]);
  const [timelineData, setTimelineData]     = useState<TimelineDataPoint[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<'CONNECTED' | 'DISCONNECTED' | 'HISTORICAL'>('DISCONNECTED');
  const [historicalPoints, setHistoricalPoints] = useState<HistoricalDataPoint[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [simStep, setSimStep]               = useState(0);
  const [isPaused, setIsPaused]             = useState(false);
  const [playbackSpeed, setPlaybackSpeed]   = useState(1);
  const [isAudioEnabled, setIsAudioEnabled] = useState(false);
  const [isAppReady, setIsAppReady]         = useState(false);

  // ── Snapshot state ──────────────────────────────────────────────────────────
  // When non-null: all display components use snapshot data instead of live data.
  // Cleared by "Return to Live" button which causes React to immediately re-point
  // all active* variables back to the live state stream.
  const [snapshotEvent, setSnapshotEvent]   = useState<CriticalEvent | null>(null);

  // ── Active variable pattern ─────────────────────────────────────────────────
  // These are what every display component reads.
  // If a snapshot is selected → frozen data. Otherwise → live data.
  const activeStress      = snapshotEvent?.snapshot?.stress   ?? stress;
  const activeSignals     = snapshotEvent?.snapshot?.signals  ?? signals;
  const activeCausal      = snapshotEvent?.snapshot?.causal   ?? causal;
  const activeTrace       = snapshotEvent?.snapshot?.trace    ?? trace;
  const activeTick        = snapshotEvent?.snapshot?.tick     ?? lastTick;
  const activeTimeline    = snapshotEvent?.snapshot?.timelineAtCapture ?? timelineData;

  // ── Refs ────────────────────────────────────────────────────────────────────
  const analyticsRef        = useRef<AnalyticsEngine>(new AnalyticsEngine());
  const audioRef            = useRef<AudioEngine>(new AudioEngine());
  const binanceRef          = useRef<BinanceService | null>(null);
  const simTimerRef         = useRef<any>(null);
  const simStepRef          = useRef<number>(0);
  const historicalPointsRef = useRef<HistoricalDataPoint[]>([]);
  const isPausedRef         = useRef<boolean>(false);
  // timelineDataRef keeps a stable reference for snapshot capture without
  // needing timelineData in useCallback dependency arrays
  const timelineDataRef     = useRef<TimelineDataPoint[]>([]);

  const historyLoader = useMemo(() => new HistoricalDataLoader(), []);

  useEffect(() => { historicalPointsRef.current  = historicalPoints; }, [historicalPoints]);
  useEffect(() => { isPausedRef.current          = isPaused; },        [isPaused]);
  useEffect(() => { timelineDataRef.current      = timelineData; },     [timelineData]);

  const toggleAudio = useCallback(() => {
    const newState = audioRef.current.toggle();
    setIsAudioEnabled(newState);
  }, []);

  // Enrich a raw CriticalEvent with a full MarketSnapshot before logging it.
  // The snapshot is a time-capsule of the exact market state at this moment.
  const enrichAndLog = useCallback((
    event:   CriticalEvent,
    result:  { stress: StressScore, signals: Record<SignalType, SignalOutput>, causal: CausalSequence, trace: DecisionTrace },
    tick:    NormalizedMarketTick
  ) => {
    const snapshot: MarketSnapshot = {
      stress:            result.stress,
      signals:           result.signals as Record<SignalType, SignalOutput>,
      causal:            result.causal,
      trace:             result.trace,
      tick,
      timelineAtCapture: timelineDataRef.current.slice() // snapshot of chart up to this tick
    };
    const enriched: CriticalEvent = { ...event, snapshot };
    setCriticalLog(prev => [enriched, ...prev].slice(0, 100));
  }, []);

  const removeIncident = useCallback((id: string) => {
    setCriticalLog(prev => prev.filter(item => item.id !== id));
    // If the removed event is the currently viewed snapshot, exit snapshot mode
    setSnapshotEvent(prev => prev?.id === id ? null : prev);
  }, []);

  const clearAllIncidents = useCallback((e?: React.MouseEvent) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    setCriticalLog([]);
    setSnapshotEvent(null);
  }, []);

  const exitSnapshot = useCallback(() => setSnapshotEvent(null), []);

  // ── Live tick handler ────────────────────────────────────────────────────────
  const handleLiveTick = useCallback((tick: NormalizedMarketTick) => {
    try {
      const result = analyticsRef.current.processTick(tick);
      setLastTick(tick);
      setIsAppReady(true);
      setSignals(result.signals);
      setStress(result.stress);
      setCausal(result.causal);
      setTrace(result.trace);
      if (result.stress) audioRef.current.setStress(result.stress.score);
      if (result.criticalEvent) enrichAndLog(result.criticalEvent, result, tick);
      setTimelineData(prev => [...prev, {
        timestamp: tick.exchange_timestamp,
        price:     tick.price,
        stress:    result.stress.score
      }].slice(-100));
    } catch (err) {
      console.error('[Sentinel] handleLiveTick error:', err);
    }
  }, [enrichAndLog]);

  // ── Historical data loader ───────────────────────────────────────────────────
  const loadCovidData = useCallback(async () => {
    setIsLoadingHistory(true);
    try {
      const data = await historyLoader.loadCovidCrash();
      setHistoricalPoints(data);
      historicalPointsRef.current = data;
      setSimStep(0);
      simStepRef.current = 0;
      setIsPaused(false);
      isPausedRef.current = false;
    } catch (e) {
      alert("Failed to load historical data. Reverting to Live mode.");
      setMode('LIVE');
    } finally {
      setIsLoadingHistory(false);
    }
  }, [historyLoader]);

  // ── Seek handler ─────────────────────────────────────────────────────────────
  // FIX: on seek, reset the REAL engine and replay (stepIndex - 200) → stepIndex
  // in one pass. This warms all buffers to the correct state AND builds the
  // timeline simultaneously. Never calls processTick on the real engine with
  // stale context (the original bug).
  const runHistoryStep = useCallback((stepIndex: number, isSeeking = false) => {
    try {
      const points = historicalPointsRef.current;
      const point  = points[stepIndex];
      if (!point) return;

      if (isSeeking) {
        analyticsRef.current.reset();
        const startIdx   = Math.max(0, stepIndex - 200);
        const seekPoints: TimelineDataPoint[] = [];
        let seekResult: ReturnType<AnalyticsEngine['processTick']> | null = null;
        let seekTick:   NormalizedMarketTick | null = null;

        for (let i = startIdx; i <= stepIndex; i++) {
          const hPoint = points[i];
          if (!hPoint) continue;
          const hTick = historyLoader.convertToTick(hPoint);
          const res   = analyticsRef.current.processTick(hTick);
          seekResult  = res;
          seekTick    = hTick;
          seekPoints.push({
            timestamp: hTick.exchange_timestamp,
            price:     hTick.price,
            stress:    res.stress.score,
            label:     hPoint.close < hPoint.open * 0.95 ? 'MAJOR DROP' : null
          });
        }
        // Guard: recharts crashes with <2 points
        setTimelineData(seekPoints.length >= 2 ? seekPoints : []);

        if (seekResult && seekTick) {
          setLastTick(seekTick);
          setSignals(seekResult.signals);
          setStress(seekResult.stress);
          setCausal(seekResult.causal);
          setTrace(seekResult.trace);
          if (seekResult.stress) audioRef.current.setStress(seekResult.stress.score);
        }
        return; // engine is now warm and display is updated — do NOT fall through
      }

      // Normal non-seek step
      const tick   = historyLoader.convertToTick(point);
      const result = analyticsRef.current.processTick(tick);
      setLastTick(tick);
      setSignals(result.signals);
      setStress(result.stress);
      setCausal(result.causal);
      setTrace(result.trace);
      if (result.stress) audioRef.current.setStress(result.stress.score);
      if (result.criticalEvent) enrichAndLog(result.criticalEvent, result, tick);
      setTimelineData(prev => [...prev, {
        timestamp: tick.exchange_timestamp,
        price:     tick.price,
        stress:    result.stress.score,
        label:     point.close < point.open * 0.95 ? 'VOLATILITY SPIKE' : null
      }].slice(-100));
    } catch (err) {
      console.error('[Sentinel] runHistoryStep error at index', stepIndex, err);
    }
  }, [historyLoader, enrichAndLog]);

  // ── Mode switch effect ────────────────────────────────────────────────────────
  useEffect(() => {
    binanceRef.current?.stop();
    clearInterval(simTimerRef.current);
    analyticsRef.current.reset();
    setTimelineData([]);
    setCriticalLog([]);
    setTrace(null);
    setLastTick(null);
    setIsAppReady(false);
    setStress(null);
    setSignals(null);
    setCausal(null);
    setSnapshotEvent(null);
    simStepRef.current = 0;
    audioRef.current.setStress(0);

    if (mode === 'LIVE') {
      setConnectionStatus('DISCONNECTED');
      binanceRef.current = new BinanceService(handleLiveTick);
      // FIX: start() is async (clock sync + WebSocket open). Await before CONNECTED.
      binanceRef.current.start().then(() => setConnectionStatus('CONNECTED'));
    } else {
      setConnectionStatus('HISTORICAL');
      loadCovidData();
    }

    return () => {
      binanceRef.current?.stop();
      clearInterval(simTimerRef.current);
    };
  }, [mode, handleLiveTick, loadCovidData]);

  // ── Playback loop ─────────────────────────────────────────────────────────────
  useEffect(() => {
    clearInterval(simTimerRef.current);
    if (mode !== 'HISTORICAL' || isPaused || historicalPoints.length === 0) return;

    const intervalMs   = playbackSpeed === 1 ? 1000 : playbackSpeed === 50 ? 40 : 50;
    const stepsPerTick = playbackSpeed === 1 ? 1    : playbackSpeed === 50 ? 2  : 5;

    simTimerRef.current = setInterval(() => {
      if (isPausedRef.current) return;
      const points = historicalPointsRef.current;
      if (!points.length) return;

      let lastResult: any                    = null;
      let lastTick:   NormalizedMarketTick | null = null;
      let lastPoint:  HistoricalDataPoint | null  = null;
      let finalStep  = simStepRef.current;
      let reachedEnd = false;

      for (let i = 0; i < stepsPerTick; i++) {
        const nextStep = simStepRef.current + 1;
        if (nextStep >= points.length) { reachedEnd = true; break; }
        simStepRef.current = nextStep;
        finalStep = nextStep;
        try {
          const point  = points[nextStep];
          const tick   = historyLoader.convertToTick(point);
          const result = analyticsRef.current.processTick(tick);
          lastResult = result;
          lastTick   = tick;
          lastPoint  = point;
          if (result.criticalEvent) enrichAndLog(result.criticalEvent, result, tick);
        } catch (e) {
          console.error('[Sentinel] batch step error at', finalStep, e);
        }
      }

      if (reachedEnd) {
        // Auto-restart: reset engine and timeline, but KEEP breach log
        // FIX: original code wiped setCriticalLog([]) here — removed
        analyticsRef.current.reset();
        simStepRef.current = 0;
        setSimStep(0);
        setTimelineData([]);
        return;
      }

      if (lastResult && lastTick && lastPoint) {
        setSimStep(finalStep);
        setLastTick(lastTick);
        setSignals(lastResult.signals);
        setStress(lastResult.stress);
        setCausal(lastResult.causal);
        setTrace(lastResult.trace);
        if (lastResult.stress) audioRef.current.setStress(lastResult.stress.score);
        setTimelineData(prev => [...prev, {
          timestamp: lastTick!.exchange_timestamp,
          price:     lastTick!.price,
          stress:    lastResult.stress.score,
          label:     lastPoint!.close < lastPoint!.open * 0.95 ? 'VOLATILITY SPIKE' : null
        }].slice(-100));
      }
    }, intervalMs);

    return () => clearInterval(simTimerRef.current);
  }, [mode, isPaused, playbackSpeed, historicalPoints, historyLoader, enrichAndLog]);

  useEffect(() => { return () => { audioRef.current.disable(); }; }, []);

  // ── Loading screens ───────────────────────────────────────────────────────────
  if (!isAppReady && mode === 'LIVE') {
    return (
      <div className="min-h-screen bg-[#0a0e14] flex flex-col items-center justify-center gap-6">
        <div className="w-16 h-16 border-2 border-cyan-500/30 border-t-cyan-400 rounded-full animate-spin" />
        <div className="flex flex-col items-center gap-2">
          <span className="text-cyan-400 font-mono text-sm uppercase tracking-[0.3em]">Sentinel</span>
          <span className="text-gray-600 font-mono text-[10px] uppercase tracking-widest animate-pulse">Connecting to Binance...</span>
        </div>
      </div>
    );
  }

  if (isLoadingHistory) {
    return (
      <div className="min-h-screen bg-[#0a0e14] flex flex-col items-center justify-center gap-6">
        <div className="w-16 h-16 border-2 border-amber-500/30 border-t-amber-400 rounded-full animate-spin" />
        <div className="flex flex-col items-center gap-2">
          <span className="text-amber-400 font-mono text-sm uppercase tracking-[0.3em]">Sentinel</span>
          <span className="text-gray-600 font-mono text-[10px] uppercase tracking-widest animate-pulse">Loading COVID Crash Dataset...</span>
        </div>
      </div>
    );
  }

  // ── Signal abbreviation helper ─────────────────────────────────────────────
  const getVectorTag = (sig: string) => {
    if (sig.includes('Liquidity'))  return 'LIQ';
    if (sig.includes('Flow'))       return 'FLOW';
    if (sig.includes('Volatility')) return 'VOL';
    if (sig.includes('Forced'))     return 'SELL';
    return sig.split(' ')[0];
  };

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col p-4 gap-4 max-w-[1920px] mx-auto overflow-hidden">

      {/* ── Header ── */}
      <header className="flex items-center justify-between bg-[#151a23] border border-gray-800 rounded-xl px-6 py-4 shadow-2xl">
        <div className="flex items-center gap-6">
          <div className="flex flex-col">
            <h1 className="text-2xl font-black tracking-tighter text-white font-mono flex items-center gap-2">
              SENTINEL <span className="text-[10px] bg-red-600 px-1.5 py-0.5 rounded tracking-normal shadow-[0_0_15px_rgba(220,38,38,0.6)]">PRO V1.0</span>
            </h1>
            <span className="text-[9px] text-gray-500 font-mono uppercase tracking-[0.2em] opacity-80">Market Microstructure Monitor</span>
          </div>
          <div className="h-8 w-px bg-gray-800" />
          <div className="flex gap-2">
            <button onClick={() => setMode('LIVE')} className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all duration-300 ${mode === 'LIVE' ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-900/30 ring-1 ring-emerald-500/50' : 'bg-gray-800 text-gray-500 hover:text-gray-300'}`}>LIVE FEED</button>
            <button onClick={() => setMode('HISTORICAL')} className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all duration-300 ${mode === 'HISTORICAL' ? 'bg-amber-600 text-white shadow-lg shadow-amber-900/30 ring-1 ring-amber-500/50' : 'bg-gray-800 text-gray-500 hover:text-gray-300'}`}>COVID CRASH REPLAY</button>
          </div>
          <button onClick={toggleAudio} className={`w-9 h-9 flex items-center justify-center rounded-lg border transition-all duration-300 ${isAudioEnabled ? 'bg-emerald-500/10 border-emerald-500 text-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.2)]' : 'bg-gray-800 border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-500'}`} title={isAudioEnabled ? "Mute" : "Enable Sonification"}>
            {isAudioEnabled
              ? <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /></svg>
              : <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" /></svg>}
          </button>
        </div>
        <div className="flex items-center gap-8">
          <div className="text-right flex flex-col items-end">
            <div className="text-[9px] text-gray-600 uppercase tracking-widest font-mono">Physical Latency</div>
            <div className={`text-xs font-black font-mono ${activeTick && (activeTick.received_timestamp - activeTick.exchange_timestamp) > 200 ? 'text-amber-500' : 'text-emerald-500'}`}>
              {activeTick ? (activeTick.received_timestamp - activeTick.exchange_timestamp) : 0}ms
            </div>
          </div>
          <div className="flex items-center gap-2 bg-[#0a0e14] px-4 py-2 rounded-lg border border-gray-800 min-w-[150px] justify-center shadow-inner">
            <div className={`w-2 h-2 rounded-full ${connectionStatus === 'CONNECTED' ? 'bg-emerald-500 animate-pulse shadow-[0_0_10px_#10b981]' : connectionStatus === 'HISTORICAL' ? 'bg-amber-500' : 'bg-red-500 animate-ping'}`} />
            <span className="text-[10px] font-black font-mono text-gray-400 uppercase tracking-widest">
              {connectionStatus === 'CONNECTED' ? 'STREAMING' : connectionStatus === 'HISTORICAL' ? 'REPLAYING' : 'IDLE'}
            </span>
          </div>
          {/* FIX [E]: data_quality indicator — shows when Binance feed data is stale/degraded */}
          {activeTick && activeTick.data_quality !== 'GOOD' && (
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-[9px] font-black font-mono uppercase tracking-widest animate-pulse ${activeTick.data_quality === 'STALE' ? 'bg-red-500/10 border-red-500/40 text-red-400' : 'bg-amber-500/10 border-amber-500/40 text-amber-400'}`}>
              <div className="w-1.5 h-1.5 rounded-full bg-current" />
              FEED {activeTick.data_quality}
            </div>
          )}
        </div>
      </header>

      {/* ── Snapshot Banner ── */}
      {snapshotEvent && (
        <div className="bg-[#1a1200] border border-amber-800/60 rounded-xl px-5 py-3 flex items-center justify-between animate-in slide-in-from-top duration-300 shadow-lg">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-amber-500 shadow-[0_0_8px_#f59e0b]" />
              <span className="text-[11px] font-black text-amber-400 uppercase tracking-[0.2em] font-mono">Snapshot Mode</span>
            </div>
            <div className="h-4 w-px bg-amber-900" />
            <span className="text-[10px] text-amber-600 font-mono">
              Viewing breach event from{' '}
              <span className="text-amber-400 font-black">
                {new Date(snapshotEvent.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
              {' '}— price{' '}
              <span className="text-amber-400 font-black">${snapshotEvent.price.toLocaleString(undefined, { minimumFractionDigits: 0 })}</span>
              {' '}— stress{' '}
              <span className={`font-black ${snapshotEvent.stress_score > 80 ? 'text-red-400' : 'text-amber-400'}`}>{snapshotEvent.stress_score}</span>
            </span>
            {snapshotEvent.snapshot?.causal.pattern_label && (
              <>
                <div className="h-4 w-px bg-amber-900" />
                <span className="text-[9px] font-black text-amber-500 uppercase tracking-widest font-mono bg-amber-900/30 px-2 py-0.5 rounded">
                  {snapshotEvent.snapshot.causal.pattern_label}
                </span>
              </>
            )}
          </div>
          <button
            onClick={exitSnapshot}
            className="flex items-center gap-2 px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-black text-[10px] font-black font-mono uppercase tracking-widest rounded transition-all shadow-lg"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            Return to Live
          </button>
        </div>
      )}

      {/* ── Historical playback controls ── */}
      {mode === 'HISTORICAL' && !isLoadingHistory && (
        <div className={`border rounded-xl px-6 py-3 flex items-center gap-6 animate-in slide-in-from-top duration-300 ${snapshotEvent ? 'bg-[#0a0e14]/60 border-gray-800/40 opacity-60' : 'bg-[#151a23] border-gray-800 border-amber-900/30'}`}>
          <button onClick={() => { const next = !isPaused; setIsPaused(next); isPausedRef.current = next; }} className="w-10 h-10 flex items-center justify-center rounded-full bg-gray-800 hover:bg-amber-600 text-white transition-all shadow-inner">
            {isPaused
              ? <svg className="w-4 h-4 ml-0.5" fill="currentColor" viewBox="0 0 20 20"><path d="M4.5 2.691l11 6.309-11 6.309V2.691z" /></svg>
              : <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M5 4h3v12H5V4zm7 0h3v12h-3V4z" /></svg>}
          </button>
          <div className="flex-1 flex flex-col gap-1">
            <div className="flex justify-between text-[10px] font-mono text-gray-500 uppercase tracking-widest">
              <span>Temporal Replay ({new Date(historicalPoints[simStep]?.timestamp || 0).toLocaleDateString()})</span>
              <span className="text-amber-500 font-bold">{Math.round((simStep / (historicalPoints.length - 1 || 1)) * 100)}% Complete</span>
            </div>
            <input type="range" min="0" max={historicalPoints.length - 1} value={simStep}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                simStepRef.current = val;
                setSimStep(val);
                setIsPaused(true);
                isPausedRef.current = true;
                runHistoryStep(val, true);
              }}
              className="w-full h-1.5 bg-gray-800 rounded-lg appearance-none cursor-pointer accent-amber-500"
            />
          </div>
          <div className="flex items-center gap-2 bg-[#0a0e14] rounded-lg p-1 border border-gray-800">
            {[1, 50, 100].map(s => (
              <button key={s} onClick={() => setPlaybackSpeed(s)} className={`px-2 py-1 text-[10px] font-bold rounded transition-colors ${playbackSpeed === s ? 'bg-amber-600 text-white' : 'text-gray-500 hover:text-gray-300'}`}>{s}x</button>
            ))}
          </div>
        </div>
      )}

      {/* ── Main layout ── */}
      <main className="flex-1 grid grid-cols-12 gap-4 h-[calc(100vh-200px)] overflow-hidden">

        {/* Left column — gauge + signal cards */}
        <div className="col-span-12 lg:col-span-3 flex flex-col gap-4 overflow-y-auto pr-2 custom-scrollbar">
          <section className={`bg-[#151a23] border rounded-xl p-6 flex flex-col items-center shadow-lg relative overflow-hidden group transition-all ${snapshotEvent ? 'border-amber-800/50' : 'border-gray-800'}`}>
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-gray-700 to-transparent opacity-50" />
            {activeStress && <StressGauge stress={activeStress} />}
          </section>
          <div className="flex flex-col gap-3">
            {activeSignals && Object.values(activeSignals).map((s, i) => (<SignalCard key={i} signal={s} />))}
          </div>
        </div>

        {/* Right column — metrics + chart + panels */}
        <div className="col-span-12 lg:col-span-9 flex flex-col gap-4 overflow-hidden">

          {/* Stat cards */}
          <div className="grid grid-cols-4 gap-4">
            <div className="bg-[#151a23] border border-gray-800 rounded-xl p-4 flex flex-col justify-between shadow-md">
              <span className="text-[10px] text-gray-500 uppercase tracking-widest block font-mono">Mark Price</span>
              <div className="text-2xl font-black font-mono tracking-tighter text-white">
                ${activeTick?.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '---'}
              </div>
            </div>
            <div className="bg-[#151a23] border border-gray-800 rounded-xl p-4 flex flex-col justify-between shadow-md">
              <span className="text-[10px] text-gray-500 uppercase tracking-widest block font-mono">Structural Spread</span>
              <div className={`text-2xl font-black font-mono tracking-tighter ${activeTick?.spread_bps && activeTick.spread_bps > 6 ? 'text-red-400' : 'text-emerald-400'}`}>
                {activeTick?.spread_bps.toFixed(2) || '---'} <span className="text-[10px] text-gray-600 font-normal">BPS</span>
              </div>
            </div>
            <div className="bg-[#151a23] border border-gray-800 rounded-xl p-4 flex flex-col justify-between shadow-md">
              <span className="text-[10px] text-gray-500 uppercase tracking-widest block font-mono">Liquidity Depth</span>
              <div className="text-2xl font-black font-mono text-blue-400 tracking-tighter">{activeTick?.total_depth.toFixed(1) || '---'}</div>
            </div>
            <div className="bg-[#151a23] border border-gray-800 rounded-xl p-4 flex flex-col justify-between shadow-md group">
              <div className="flex justify-between items-center mb-1">
                <span className="text-[10px] text-gray-500 uppercase tracking-widest font-mono">Structural Integrity</span>
                <span className={`text-[10px] font-black font-mono ${activeStress?.score && activeStress.score > 70 ? 'text-red-500' : 'text-emerald-500'}`}>
                  {activeStress ? (100 - activeStress.score) : 100}%
                </span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex gap-1.5">
                  {activeSignals && [
                    { id: 'L', type: SignalType.LIQUIDITY },
                    { id: 'F', type: SignalType.FLOW },
                    { id: 'V', type: SignalType.VOLATILITY },
                    { id: 'S', type: SignalType.FORCED_SELLING }
                  ].map(v => {
                    const active = activeSignals[v.type]?.triggered;
                    return (
                      <div key={v.id} className={`w-6 h-6 flex items-center justify-center rounded-sm text-[9px] font-black font-mono border transition-all duration-500 ${active ? 'bg-red-500/20 border-red-500 text-red-400 shadow-[0_0_12px_rgba(239,68,68,0.4)] animate-pulse' : 'bg-gray-800/40 border-gray-800 text-gray-600 grayscale'}`} title={v.type}>
                        {v.id}
                      </div>
                    );
                  })}
                </div>
                <div className={`text-xl font-black font-mono ${activeStress?.signals_aligned && activeStress.signals_aligned > 0 ? 'text-red-500' : 'text-gray-500'} group-hover:scale-110 transition-transform`}>
                  {activeStress?.signals_aligned || 0}<span className="text-[10px] text-gray-700"> ACT</span>
                </div>
              </div>
            </div>
          </div>

          <TimelineChart data={activeTimeline} />

          {/* Bottom panels — fixed height, no stretching */}
          <div className="grid grid-cols-12 gap-4 h-[1050px] min-h-[1050px] max-h-[1050px] overflow-hidden">

            {/* ── Causality Engine ── */}
            <div className="col-span-12 lg:col-span-5 bg-[#151a23] border border-gray-800 rounded-xl p-5 flex flex-col overflow-hidden relative shadow-lg">
              <div className="flex justify-between items-center mb-4">
                <div className="flex flex-col gap-0.5">
                  <h2 className="text-[11px] font-black text-amber-500 uppercase tracking-[0.3em] flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full bg-amber-500 ${activeStress?.score && activeStress.score > 50 ? 'animate-ping' : ''}`} />
                    Causality Engine
                  </h2>
                  {/* Pattern label — shows the named structural failure type */}
                  {activeCausal?.pattern_label && (
                    <span className="text-[8px] font-black text-amber-600/80 uppercase tracking-widest font-mono ml-3.5 bg-amber-500/10 px-1.5 py-0.5 rounded">
                      {activeCausal.pattern_label}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {/* Stress velocity badge */}
                  {activeCausal?.active && Math.abs(activeCausal.stress_velocity) > 0.5 && (
                    <span className={`text-[8px] font-black font-mono px-2 py-0.5 rounded uppercase tracking-tight ${activeCausal.stress_velocity > 0 ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'}`}>
                      {activeCausal.stress_velocity > 0 ? '↑' : '↓'} {Math.abs(activeCausal.stress_velocity).toFixed(1)} pts/s
                    </span>
                  )}
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-500/80" />
                    <span className="text-[8px] text-gray-600 font-mono uppercase tracking-widest">Temporal Matrix</span>
                  </div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto space-y-0 relative pr-1 custom-scrollbar min-h-0">
                {activeCausal?.active
                  ? (<>
                      <div className="absolute left-[21px] top-4 bottom-4 w-px bg-gradient-to-b from-amber-500/50 via-gray-800/20 to-transparent" />
                      {activeCausal.steps.map((step, i) => (
                        <div key={i} className="flex gap-8 items-start relative pl-10 pb-5 last:pb-2 group animate-in slide-in-from-left duration-700">
                          <div className={`absolute left-[16px] top-1.5 w-3 h-3 rounded-full border-2 bg-[#151a23] transition-all duration-300 z-10 ${step.type === 'CATALYST' ? 'border-amber-500 scale-125 shadow-[0_0_10px_#f59e0b]' : step.type === 'SYSTEMIC' ? 'border-red-500 scale-110 shadow-[0_0_10px_#ef4444]' : 'border-gray-700'}`} />
                          <div className="flex-1">
                            <div className="flex items-center justify-between mb-1">
                              <div className="flex items-center gap-2">
                                <span className={`text-[8px] font-mono px-2 py-0.5 rounded uppercase tracking-tighter ${step.type === 'CATALYST' ? 'bg-amber-500 text-black font-black shadow-[0_0_10px_rgba(245,158,11,0.4)]' : step.type === 'SYSTEMIC' ? 'bg-red-500 text-white font-black' : 'bg-gray-800 text-gray-500 font-bold'}`}>{step.type}</span>
                                <div className="text-xs font-black text-white uppercase tracking-tight font-mono">{step.signal}</div>
                              </div>
                              <div className="flex items-center gap-2">
                                {/* Intensity bar */}
                                <div className="flex items-center gap-1">
                                  <div className="w-12 h-1 bg-gray-800 rounded-full overflow-hidden">
                                    <div className={`h-full rounded-full transition-all ${step.signal_intensity > 80 ? 'bg-red-500' : step.signal_intensity > 60 ? 'bg-amber-500' : 'bg-blue-500'}`} style={{ width: `${step.signal_intensity}%` }} />
                                  </div>
                                  <span className="text-[8px] text-gray-600 font-mono">{step.signal_intensity}</span>
                                </div>
                                {/* Elapsed since catalyst */}
                                <span className="text-[9px] text-gray-700 font-mono italic">
                                  {step.elapsed_since_catalyst_ms > 0
                                    ? mode === 'HISTORICAL'
                                      // FIX [H]: Historical ticks are 1-min klines.
                                      // elapsed is kline boundary distance, not real seconds.
                                      // Show "+N candles" to prevent misreading as real signal lag.
                                      ? `+${Math.round(step.elapsed_since_catalyst_ms / 60000)} candle${Math.round(step.elapsed_since_catalyst_ms / 60000) !== 1 ? 's' : ''}`
                                      : `+${(step.elapsed_since_catalyst_ms / 1000).toFixed(0)}s`
                                    : new Date(step.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                </span>
                              </div>
                            </div>
                            {/* Contribution bar */}
                            <div className="flex items-center gap-1.5 mb-1.5">
                              <div className="flex-1 h-0.5 bg-gray-800 rounded-full overflow-hidden">
                                <div className="h-full bg-amber-500/60 rounded-full" style={{ width: `${step.stress_contribution_pct}%` }} />
                              </div>
                              <span className="text-[8px] text-amber-600/80 font-mono font-black">{step.stress_contribution_pct.toFixed(0)}%</span>
                            </div>
                            <p className="text-[10px] text-gray-400 leading-snug font-sans bg-gray-900/50 p-2.5 rounded-lg border border-gray-800/80 hover:border-gray-700 transition-colors shadow-inner">{step.description}</p>
                          </div>
                        </div>
                      ))}
                    </>)
                  : (
                    <div className="h-full flex flex-col items-center justify-center text-gray-700 space-y-5 opacity-20 grayscale">
                      <div className="w-16 h-16 border-2 border-dashed border-gray-800 rounded-full animate-spin duration-[20s]" />
                      <span className="text-[9px] font-mono italic uppercase tracking-widest text-center leading-loose">Awaiting structural anomalies...<br/>Continuous state monitoring active.</span>
                    </div>
                  )}
              </div>

              {activeCausal?.active && (
                <div className="mt-3 pt-3 border-t border-gray-800 bg-[#151a23]/80 backdrop-blur-sm">
                  <p className="text-[9px] text-emerald-400 font-black font-mono uppercase tracking-tighter animate-pulse flex items-center gap-2">
                    <svg className="w-3 h-3 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" /></svg>
                    {activeCausal.risk_assessment}
                  </p>
                </div>
              )}
            </div>

            {/* ── Breach Log ── */}
            <div className="col-span-12 lg:col-span-7 bg-[#151a23] border border-gray-800 rounded-xl p-5 flex flex-col overflow-hidden shadow-2xl relative">
              <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/5 blur-[80px] rounded-full pointer-events-none z-0" />
              <div className="flex justify-between items-center mb-4 relative z-10">
                <div className="flex flex-col">
                  <h2 className="text-[11px] font-black text-blue-400 uppercase tracking-[0.3em]">Breach Log</h2>
                  <span className="text-[8px] text-gray-600 font-mono uppercase tracking-widest">Stress Event Log · Click eye to inspect snapshot</span>
                </div>
                <div className="flex gap-2">
                  <span className="text-[9px] text-gray-600 font-mono px-3 py-1 bg-[#0a0e14] border border-gray-800 rounded-full flex items-center gap-2 shadow-inner">
                    <div className="w-1 h-1 rounded-full bg-blue-500 shadow-[0_0_5px_#3b82f6]" />{criticalLog.length} INCIDENTS
                  </span>
                  <button type="button" onClick={(e) => clearAllIncidents(e)} className="text-[9px] text-gray-200 font-black font-mono px-3 py-1 bg-gray-800 hover:bg-gray-700 rounded border border-gray-700 transition-all uppercase tracking-widest shadow-lg cursor-pointer">Flush</button>
                </div>
              </div>

              {/* Scrollable log — never stretches the panel */}
              <div className="flex-1 overflow-y-auto space-y-3 pr-1 custom-scrollbar relative z-10 min-h-0">
                {criticalLog.length > 0 ? criticalLog.map((event, eventIdx) => {
                  const isActive = snapshotEvent?.id === event.id;
                  return (
                    <div key={event.id} className={`p-4 backdrop-blur-md border rounded-xl transition-all group relative overflow-hidden shadow-sm ${isActive ? 'bg-amber-900/20 border-amber-600/60 shadow-[0_0_20px_rgba(245,158,11,0.15)]' : 'bg-[#0a0e14]/40 border-gray-800/60 hover:border-gray-600'}`}>
                      <div className={`absolute left-0 top-0 bottom-0 w-1.5 ${event.stress_score > 80 ? 'bg-red-500 shadow-[0_0_15px_rgba(239,68,68,0.6)]' : 'bg-amber-500'}`} />
                      <div className="flex justify-between items-start mb-2">
                        <div className="flex flex-col">
                          <span className={`text-[10px] font-black font-mono uppercase tracking-tight ${event.stress_score > 80 ? 'text-red-400' : 'text-gray-300'}`}>{event.level} REGIME</span>
                          <span className="text-[9px] text-gray-600 font-mono">
                            {new Date(event.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })} • #{criticalLog.length - eventIdx}
                          </span>
                          {/* Pattern label on the card */}
                          {event.snapshot?.causal.pattern_label && (
                            <span className="text-[8px] text-amber-600/70 font-mono uppercase tracking-widest mt-0.5">{event.snapshot.causal.pattern_label}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="text-right">
                            <div className="text-[13px] font-black text-white font-mono tracking-tighter">${event.price.toLocaleString(undefined, { minimumFractionDigits: 1 })}</div>
                            <div className={`text-[9px] font-black font-mono ${event.stress_score > 70 ? 'text-red-500' : 'text-amber-500'}`}>STRESS: {event.stress_score}</div>
                          </div>
                          {/* View Snapshot button — eye icon */}
                          {event.snapshot && (
                            <button
                              type="button"
                              onClick={() => setSnapshotEvent(isActive ? null : event)}
                              className={`p-1.5 rounded border transition-all ${isActive ? 'bg-amber-600 text-black border-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.4)]' : 'opacity-0 group-hover:opacity-100 bg-gray-800 hover:bg-amber-900/40 text-gray-500 hover:text-amber-400 border-gray-700 hover:border-amber-900/60'}`}
                              title={isActive ? 'Exit snapshot' : 'View snapshot'}
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                              </svg>
                            </button>
                          )}
                          {/* Delete button */}
                          <button type="button" onClick={() => removeIncident(event.id)} className="opacity-0 group-hover:opacity-100 p-1.5 bg-gray-800 hover:bg-red-900/40 text-gray-500 hover:text-red-500 rounded border border-gray-700 hover:border-red-900/60 transition-all" title="Remove">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                          </button>
                        </div>
                      </div>
                      <div className="text-[10px] text-gray-400 leading-snug mb-2.5 font-sans opacity-90 group-hover:opacity-100 border-l border-gray-800/80 pl-3 py-0.5 italic bg-gray-900/20 rounded-r">{event.narrative}</div>
                      <div className="flex gap-2 flex-wrap items-center">
                        <span className="text-[8px] text-gray-700 uppercase font-mono font-bold tracking-widest">Signals:</span>
                        {event.signals.map((sig, idx) => (
                          <span key={idx} className="text-[8px] bg-[#0a0e14] text-blue-400 px-2 py-0.5 rounded-sm border border-blue-500/10 font-mono font-black hover:border-blue-400/50 transition-colors">{getVectorTag(sig)}</span>
                        ))}
                      </div>
                    </div>
                  );
                }) : (
                  <div className="h-full flex flex-col items-center justify-center text-gray-800 space-y-3 opacity-30">
                    <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={0.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                    <span className="text-[9px] font-mono italic uppercase tracking-[0.4em] text-center">No breach events logged</span>
                  </div>
                )}
              </div>

              <div className="mt-3 pt-3 border-t border-gray-800/40 flex justify-between items-center bg-[#151a23]/60 relative z-10">
                <p className="text-[8px] text-gray-600 leading-tight max-w-[75%] font-mono uppercase tracking-widest opacity-80">
                  Logs stress events above threshold 60. Hover to view snapshot.
                </p>
                <span className="text-[9px] text-gray-700 font-mono font-bold">SENTINEL</span>
              </div>
            </div>

          </div>
        </div>
      </main>

      <div className="px-6 pb-6">
        <ExplainabilityLayer trace={activeTrace} stress={activeStress} signals={activeSignals} />
      </div>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: rgba(0,0,0,0.02); }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #1f2937; border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #374151; }
      `}</style>
    </div>
  );
};

const WrappedApp: React.FC = () => (
  <ErrorBoundary><App /></ErrorBoundary>
);

export default WrappedApp;
