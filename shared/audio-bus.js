// Audio bus with priority + ducking. Centralizes every sound the overlay
// (or editor preview) plays so a scene's music can suppress alert SFX
// while it's playing, voice-overs can solo, etc. Single AudioContext
// per page; per-sound GainNode chain → master gain → destination.
//
// Policy semantics (applied while THIS sound is playing, to LOWER-priority
// sounds — equal-priority sounds always coexist):
//
//   'mix'           Default. No effect on other sounds.
//   'duck-below'    Attenuates lower-priority sounds by `duckRatio` (0.2
//                   = -14 dB). Sounds return to full volume when this
//                   one ends.
//   'solo'          Mutes lower-priority sounds (gain → 0) for the
//                   duration. They resume when this one ends.
//   'cancel-below'  Stops lower-priority sounds immediately. They do
//                   NOT resume.
//
// Default priority is 50. Convention: ambient=20, sfx=50, scene-audio=60,
// alert=80, voice=90. The scale is open — anything 0..100 works — but
// staying near the conventions keeps multi-scene authoring predictable.

const DEFAULT_PRIORITY     = 50;
const DEFAULT_POLICY       = 'mix';
const DEFAULT_DUCK_RATIO   = 0.2;     // -14 dB
const VALID_POLICIES       = new Set(['mix', 'duck-below', 'solo', 'cancel-below']);

class AudioBus {
  constructor() {
    this._ctx        = null;
    this._masterGain = null;
    this._masterVol  = 1.0;
    this._active     = [];   // [{ id, audio, sourceNode, gainNode, priority, policy, baseVol, loop }]
    this._nextId     = 1;
  }

  // Lazy AudioContext creation. Browsers block AudioContext until a user
  // gesture; resume() inside play() handles the unlock when the streamer
  // first interacts with the dashboard or overlay.
  _ensureCtx() {
    if (this._ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      console.warn('[audio-bus] Web Audio API unavailable; falling back to muted no-op.');
      return;
    }
    this._ctx = new Ctx();
    this._masterGain = this._ctx.createGain();
    this._masterGain.gain.value = this._masterVol;
    this._masterGain.connect(this._ctx.destination);
  }

  setMasterVolume(v) {
    this._masterVol = Math.max(0, Math.min(1, v));
    if (this._masterGain) this._masterGain.gain.value = this._masterVol;
  }

  // Returns a handle with .stop(); caller can keep it to stop the sound
  // explicitly (e.g., scene-player tears down all its handles on scene end).
  // Returns null if Web Audio is unavailable (caller can ignore).
  play({ src, vol = 1, priority = DEFAULT_PRIORITY, policy = DEFAULT_POLICY, loop = false, id = null }) {
    if (!src) return null;
    this._ensureCtx();
    if (!this._ctx) return null;
    if (this._ctx.state === 'suspended') this._ctx.resume().catch(() => {});
    if (!VALID_POLICIES.has(policy)) policy = DEFAULT_POLICY;

    const path = `/assets/sounds/${encodeURIComponent(src)}`;
    const audio = new Audio(path);
    audio.crossOrigin = 'anonymous';
    audio.loop = !!loop;
    let sourceNode;
    try {
      sourceNode = this._ctx.createMediaElementSource(audio);
    } catch (err) {
      // createMediaElementSource throws on certain edge cases (already-bound
      // element, etc.). Fall back to native playback so the sound still
      // happens — just bypasses bus mixing for this one entry.
      console.warn('[audio-bus] createMediaElementSource failed for', src, '— falling back to native play:', err.message);
      audio.volume = Math.max(0, Math.min(1, this._masterVol * vol));
      audio.play().catch(() => {});
      return { stop: () => { audio.pause(); audio.currentTime = 0; } };
    }
    const gainNode = this._ctx.createGain();
    gainNode.gain.value = vol;
    sourceNode.connect(gainNode).connect(this._masterGain);

    const entry = {
      id: id || ('s' + this._nextId++),
      audio, sourceNode, gainNode,
      priority, policy, baseVol: vol, loop: !!loop,
      stopped: false,
    };

    audio.addEventListener('ended', () => this._remove(entry));
    audio.addEventListener('error', () => this._remove(entry));

    // Apply cancel-below BEFORE adding the new sound so we don't accidentally
    // cancel ourselves (priority equal-or-higher to ourselves is preserved).
    if (policy === 'cancel-below') {
      for (const other of [...this._active]) {
        if (other.priority < priority) other.stop?.() || this._stopEntry(other);
      }
    }

    this._active.push(entry);
    this._recomputeGains();
    audio.play().catch(err => {
      console.warn('[audio-bus] play blocked:', err?.message || err);
      this._remove(entry);
    });

    const handle = {
      id: entry.id,
      stop: () => this._stopEntry(entry),
      setVolume: (v) => { entry.baseVol = Math.max(0, Math.min(1, v)); this._recomputeGains(); },
    };
    entry.stop = handle.stop;
    return handle;
  }

  // Stop everything with a matching predicate (or everything if no predicate).
  // Used by the scene-player on scene end to clean up only its own audio.
  stopWhere(predicate) {
    for (const entry of [...this._active]) {
      if (!predicate || predicate(entry)) this._stopEntry(entry);
    }
  }

  _stopEntry(entry) {
    if (entry.stopped) return;
    entry.stopped = true;
    try { entry.audio.pause(); entry.audio.currentTime = 0; } catch {}
    try { entry.sourceNode.disconnect(); entry.gainNode.disconnect(); } catch {}
    this._remove(entry);
  }

  _remove(entry) {
    const idx = this._active.indexOf(entry);
    if (idx >= 0) this._active.splice(idx, 1);
    this._recomputeGains();
  }

  // For each active sound, look at every OTHER active sound with strictly
  // higher priority and combine their effects multiplicatively. duck-below
  // applies duckRatio; solo applies 0; cancel-below is handled at play()
  // time so it never appears here. The minimum of the combined ratio and
  // the sound's own base volume becomes the effective gain.
  _recomputeGains() {
    if (!this._ctx) return;
    const now = this._ctx.currentTime;
    for (const a of this._active) {
      let ratio = 1.0;
      for (const b of this._active) {
        if (b === a) continue;
        if (b.priority <= a.priority) continue;
        if (b.policy === 'duck-below') ratio = Math.min(ratio, DEFAULT_DUCK_RATIO);
        else if (b.policy === 'solo')  ratio = 0;
      }
      const target = a.baseVol * ratio;
      // Short ramp for click-free transitions when ducking engages/releases.
      a.gainNode.gain.setTargetAtTime(target, now, 0.05);
    }
  }
}

// Page-singleton — every importer shares the same bus + AudioContext.
export const audioBus = new AudioBus();
