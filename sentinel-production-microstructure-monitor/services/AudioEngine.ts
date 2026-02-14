
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  
  // Oscillators for the "Frequency" sound
  private oscMain: OscillatorNode | null = null;
  private oscSub: OscillatorNode | null = null;
  private oscHarm: OscillatorNode | null = null;
  
  public isMuted: boolean = true;

  constructor() {}

  private init() {
    if (this.ctx) return;
    
    // Initialize Audio Context
    const AudioContextClass = (window as any).AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AudioContextClass();
    if (!this.ctx) return;

    // Master Output Chain
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0;
    
    // Dynamics Compressor to glue the oscillators together and prevent clipping
    const compressor = this.ctx.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.knee.value = 30;
    compressor.ratio.value = 12;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;

    this.masterGain.connect(compressor);
    compressor.connect(this.ctx.destination);

    const now = this.ctx.currentTime;

    // --- OSCILLATOR ARCHITECTURE ---
    // A sophisticated "monitor" tone composed of a fundamental, a sub-octave, and a detuned interference layer.

    // 1. Main Frequency (The precise data indicator)
    this.oscMain = this.ctx.createOscillator();
    this.oscMain.type = 'sine'; // Pure tone
    this.oscMain.frequency.value = 80; // Start low
    this.oscMain.start(now);

    const gainMain = this.ctx.createGain();
    gainMain.gain.value = 0.4;
    this.oscMain.connect(gainMain);
    
    // 2. Sub Frequency (The weight/presence)
    this.oscSub = this.ctx.createOscillator();
    this.oscSub.type = 'sine';
    this.oscSub.frequency.value = 40; // Octave below
    this.oscSub.start(now);

    const gainSub = this.ctx.createGain();
    gainSub.gain.value = 0.3;
    this.oscSub.connect(gainSub);

    // 3. Interference Layer (The texture)
    // This oscillator runs slightly off-pitch to create a "beating" or "pulsing" sensation that speeds up with stress
    this.oscHarm = this.ctx.createOscillator();
    this.oscHarm.type = 'sine';
    this.oscHarm.frequency.value = 81; // Slight detune initially
    this.oscHarm.start(now);

    const gainHarm = this.ctx.createGain();
    gainHarm.gain.value = 0.25;
    this.oscHarm.connect(gainHarm);

    // Spatialization (If supported)
    if (this.ctx.createStereoPanner) {
        const panLeft = this.ctx.createStereoPanner();
        panLeft.pan.value = -0.15;
        gainMain.connect(panLeft).connect(this.masterGain);

        const panRight = this.ctx.createStereoPanner();
        panRight.pan.value = 0.15;
        gainHarm.connect(panRight).connect(this.masterGain);
        
        // Sub stays center
        gainSub.connect(this.masterGain);
    } else {
        // Fallback for older browsers
        gainMain.connect(this.masterGain);
        gainHarm.connect(this.masterGain);
        gainSub.connect(this.masterGain);
    }
  }

  public setStress(score: number) {
    if (!this.ctx || this.isMuted) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();

    const t = this.ctx.currentTime;
    // Normalize stress 0.0 - 1.0
    const s = Math.min(100, Math.max(0, score)) / 100; 

    // --- FREQUENCY MAPPING ---
    // Sophisticated Exponential Curve:
    // Low Stress (0%): ~80Hz (Deep, calm drone)
    // Critical Stress (100%): ~800Hz (Urgent, piercing but pure)
    // The curve is gentle at first, then ramps up.
    const baseFreq = 80 * Math.pow(10, s * 1.0); // 80 -> 800

    // Immediate reaction time (30ms) for "fast reacting" feel without clicking
    const reactionTime = 0.03;

    this.oscMain?.frequency.setTargetAtTime(baseFreq, t, reactionTime);
    this.oscSub?.frequency.setTargetAtTime(baseFreq * 0.5, t, reactionTime);

    // --- BEATING/PULSE TEXTURE ---
    // Instead of a separate LFO, we use the interference between Main and Harm oscillators.
    // Detune Amount (Hz):
    // 0% Stress: 0.5Hz difference (Slow breathing pulse)
    // 100% Stress: 20Hz difference (Rapid fluttering/roughness)
    const beatFreq = 0.5 + (Math.pow(s, 2) * 19.5);
    
    this.oscHarm?.frequency.setTargetAtTime(baseFreq + beatFreq, t, reactionTime);
  }

  public enable() {
    this.init();
    if (this.ctx?.state === 'suspended') this.ctx.resume();
    this.isMuted = false;
    
    // Smooth fade in
    if (this.masterGain) {
      this.masterGain.gain.cancelScheduledValues(this.ctx!.currentTime);
      this.masterGain.gain.setTargetAtTime(0.5, this.ctx!.currentTime, 0.1);
    }
  }

  public disable() {
    this.isMuted = true;
    // Smooth fade out
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.cancelScheduledValues(this.ctx.currentTime);
      this.masterGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
    }
  }

  public toggle(): boolean {
    if (this.isMuted) {
      this.enable();
    } else {
      this.disable();
    }
    return !this.isMuted;
  }
}
