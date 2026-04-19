// Maps normalized event types → arrays of effect descriptors sent to the overlay.

const rnd = () => Math.random();

export function router(ctx) {
  const { event } = ctx;
  // Ensure payload and user exist so banner templates never render "undefined"
  event.payload      = event.payload ?? {};
  event.payload.user = event.payload.user ?? 'Someone';
  event.effects      = EFFECT_MAP[event.type]?.(event) ?? [];
}

const EFFECT_MAP = {

  // ── Follow ──────────────────────────────────────────────────────────────────
  follow: (e) => [
    { effect: 'alert-banner',  payload: { tier: 'B', icon: '💚', text: `${e.payload.user} followed!`, sound: 'follow.wav' } },
    { effect: 'balloon',       payload: { count: 1, sound: 'pop.wav' } },
  ],

  // ── Sub ─────────────────────────────────────────────────────────────────────
  sub: (e) => [
    { effect: 'alert-banner',  payload: { tier: 'A', icon: '💜', text: `${e.payload.user} subscribed!`, subText: e.payload.message, bannerColor: '#9147FF', glowColor: 'rgba(145,71,255,0.6)', sound: 'sub.wav' } },
    { effect: 'balloon',       payload: { count: 3, sound: 'pop.wav' } },
    { effect: 'floating-text', payload: { text: '+1 SUB', x: rnd(), y: 0.75 } },
  ],

  // ── Gift Sub ─────────────────────────────────────────────────────────────────
  'sub.gifted': (e) => {
    const n    = e.payload.count ?? 1;
    const tier = n >= 10 ? 'S' : 'A';
    return [
      { effect: 'alert-banner',  payload: { tier, icon: '🎁', text: `${e.payload.user} gifted ${n} sub${n > 1 ? 's' : ''}!`, bannerColor: '#FF9A3C', glowColor: 'rgba(255,154,60,0.6)', sound: 'gift.wav' } },
      { effect: n >= 5 ? 'firework-salvo' : 'firework', payload: { count: n >= 5 ? 4 : 1, sound: 'boom.wav' } },
      ...(n >= 10 ? [{ effect: 'confetti', payload: { sound: 'confetti.wav' } }] : []),
      { effect: 'floating-text', payload: { text: `+${n} GIFT${n > 1 ? 'S' : ''}`, x: rnd(), y: 0.75 } },
    ];
  },

  // ── Sub Combo ────────────────────────────────────────────────────────────────
  'sub.combo': (e) => [
    { effect: 'combo-display', payload: { ...e.payload, sound: 'combo.wav' } },
    ...(e.payload.level >= 3
      ? [{ effect: 'crowd-explosion', payload: { sound: 'explosion.wav' } }]
      : [{ effect: 'confetti',        payload: { sound: 'confetti.wav' } }]),
  ],

  // ── Cheer Combo ──────────────────────────────────────────────────────────────
  'cheer.combo': (e) => [
    { effect: 'combo-display', payload: { ...e.payload, sound: 'combo.wav' } },
    ...(e.payload.level >= 3
      ? [{ effect: 'firework-salvo',  payload: { count: 3, sound: 'boom.wav' } }]
      : [{ effect: 'firework',        payload: { sound: 'boom.wav' } }]),
  ],

  // ── Cheer ────────────────────────────────────────────────────────────────────
  cheer: (e) => {
    const bits = e.payload.bits ?? 0;
    if (bits >= 1000) return [
      { effect: 'alert-banner',  payload: { tier: 'S', icon: '💎', text: `${e.payload.user} cheered ${bits.toLocaleString()} bits!!!`, sound: 'bits-huge.wav' } },
      { effect: 'crowd-explosion', payload: { sound: 'explosion.wav' } },
    ];
    if (bits >= 100) return [
      { effect: 'alert-banner',  payload: { tier: 'A', icon: '💎', text: `${e.payload.user} cheered ${bits} bits!`, bannerColor: '#FF6905', glowColor: 'rgba(255,105,5,0.6)', sound: 'bits-large.wav' } },
      { effect: 'firework',      payload: { sound: 'boom.wav' } },
    ];
    return [
      { effect: 'floating-text', payload: { text: `${bits} bits`, x: rnd(), y: 0.8 } },
      { effect: 'balloon',       payload: { count: 1, sound: 'pop.wav' } },
    ];
  },

  // ── Raid ─────────────────────────────────────────────────────────────────────
  raid: (e) => {
    const viewers = e.payload.viewers ?? 0;
    const tier    = viewers >= 50 ? 'S' : 'A';
    return [
      { effect: 'alert-banner',    payload: { tier, icon: '⚡', text: `${e.payload.user} raided with ${viewers} viewers!`, bannerColor: '#00C8AF', glowColor: 'rgba(0,200,175,0.6)', sound: 'raid.wav' } },
      { effect: viewers >= 50 ? 'crowd-explosion' : 'firework', payload: { sound: viewers >= 50 ? 'explosion.wav' : 'boom.wav' } },
      { effect: 'confetti',        payload: { sound: 'confetti.wav' } },
    ];
  },

  // ── Hype Train ───────────────────────────────────────────────────────────────
  'hype-train.start': () => [
    { effect: 'alert-banner', payload: { tier: 'A', icon: '🔥', text: 'HYPE TRAIN STARTED!', subText: "Let's gooo!", bannerColor: '#FF4500', glowColor: 'rgba(255,69,0,0.6)', sound: 'hype-start.wav' } },
    { effect: 'confetti',     payload: { sound: 'confetti.wav' } },
  ],

  'hype-train.progress': (e) => [
    { effect: 'alert-banner',    payload: { tier: 'S', icon: '🔥', text: `HYPE TRAIN  LEVEL ${e.payload.level}!`, sound: 'hype-level.wav' } },
    { effect: 'crowd-explosion', payload: { sound: 'explosion.wav' } },
  ],

  'hype-train.end': (e) => [
    { effect: 'alert-banner', payload: { tier: 'A', icon: '🔥', text: `Hype Train ended at Level ${e.payload.level}!`, subText: 'Thanks for the hype, chat!', sound: 'hype-end.wav' } },
    { effect: 'confetti',     payload: { sound: 'confetti.wav' } },
    { effect: 'firework-salvo', payload: { count: 3, sound: 'boom.wav' } },
  ],
};
