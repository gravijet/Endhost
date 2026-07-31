// The game's menu click, and nothing else. A WAV, not the MP3 it was cut from:
// at ~110ms an MP3's encoder delay can put silence in front of the transient,
// and the whole job of this sound is to land the instant you press.

const SRC = '/assets/sfx/click.wav';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let buf: AudioBuffer | null = null;
let armed = false;

// Browsers refuse to start an AudioContext before a gesture. Capture the first
// one so this runs before the handlers that actually play.
['pointerdown', 'keydown'].forEach((ev) =>
  addEventListener(ev, () => { armed = true; }, { once: true, capture: true }),
);

function boot(): void {
  if (ctx) return;
  const AC = window.AudioContext || (window as any).webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);
  fetch(SRC, { cache: 'force-cache' })
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('no sfx'))))
    .then((b) => ctx!.decodeAudioData(b))
    .then((decoded) => { buf = decoded; })
    .catch(() => { /* undecodable or missing: the interface is simply silent */ });
}

export const sound = {
  click(): void {
    if (!armed) return;
    boot();
    if (!ctx || !buf || !master) return;
    if (ctx.state === 'suspended') void ctx.resume();
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.connect(master);
    s.start(ctx.currentTime);
  },
};

// One delegated listener plays the click for everything that is pressed — links,
// buttons, summaries, and anything opting in with [data-click]. Capture phase, so
// it fires even when a handler stops propagation.
export function wireClicks(): void {
  document.addEventListener(
    'pointerdown',
    (e) => {
      const t = e.target as Element | null;
      if (t?.closest('a[href], button, summary, [role="button"], [data-click], .btn')) sound.click();
    },
    { capture: true },
  );
}
