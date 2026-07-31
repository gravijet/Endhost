import { wireClicks } from './sound.js';
import { $ } from './dom.js';
import { motdToHtml } from './mc.js';
import { api } from './api.js';

wireClicks();

// The one bit of the landing that is a live number: how many servers are up and
// how many slots are free right now. Real, or it does not show.
async function fillCapacity(): Promise<void> {
  const line = $('#capLine');
  try {
    const c = await api.capacity();
    if (!line) return;
    const free = Math.max(0, c.maxTotal - c.total);
    line.innerHTML =
      `<span class="dot ${c.running ? 'on' : 'off'}"></span>` +
      `<b>${c.running}</b> running now · <b>${free}</b> of ${c.maxTotal} free slots` +
      (c.accepting ? '' : ' · <span class="t-red">full</span>');
  } catch {
    if (line) line.textContent = 'Panel status unavailable right now.';
  }
}
fillCapacity();

// Render the example MOTD in the hero row through the real § renderer, so the
// row on the page uses the same code path a real MOTD would.
const motd = $('#heroMotd');
if (motd) motd.innerHTML = motdToHtml('§dEnd City §8» §fsurvival, claims, no lag');

// Footer year.
const yr = $('#year');
if (yr) yr.textContent = String(new Date().getFullYear());
