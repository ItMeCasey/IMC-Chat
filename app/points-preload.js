'use strict';
/**
 * Runs inside a hidden window that shows Twitch's own chat-only page (twitch.tv/popout/<channel>/chat) in the app's logged-in Twitch window.
 * Like a browser extension, it reads your channel-points balance off that page and presses "Claim Bonus" when the chest appears, then tells the app.
 */
const { ipcRenderer } = require('electron');
const channel = (process.argv.find((a) => a.startsWith('--imc-channel=')) || '').slice(14);
let last = null, lastBits = null, lastClaim = 0;
const text = (el) => ((el && el.textContent) || '').trim();
function balance() {
  for (const s of ['[data-test-selector="copo-balance-string"]', '.community-points-summary [data-test-selector="balance-string"]']) {
    const t = text(document.querySelector(s)); if (/^\d[\d.,]*\s*[KMB]?$/i.test(t)) return t.replace(/\s/g, '');
  }
  const box = document.querySelector('.community-points-summary');
  if (box) { const m = /(\d[\d.,]*\s*[KMB]?)\s*$/i.exec(text(box).replace(/Claim Bonus/i, '')); if (m) return m[1].replace(/\s/g, ''); }
  return '';
}
function bits() {
  const t = text(document.querySelector('[data-test-selector="bits-balance-string"]')); return /^\d[\d.,]*\s*[KMB]?$/i.test(t) ? t.replace(/\s/g, '') : '';
}
function claim() {
  const icon = document.querySelector('.claimable-bonus__icon'), btn = (icon && icon.closest('button')) || document.querySelector('button[aria-label="Claim Bonus"]');
  if (btn && Date.now() - lastClaim > 20000) { lastClaim = Date.now(); btn.click(); return true; }
  return false;
}
setInterval(() => {
  try { const claimed = claim(), b = balance(), t = bits(); if (claimed || b !== last || t !== lastBits) { last = b; lastBits = t; ipcRenderer.send('points:update', { channel, balance: b, bits: t, claimed }); } } catch (e) { /* the page changed: nothing to report */ }
}, 4000);

// Commands from IMC-Chat's own rewards list. The menu is opened and read on this hidden page, and "redeem" presses Twitch's own button, but only after you confirmed in IMC-Chat.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const menuRoot = () => document.querySelector('.reward-center__content');
let rewardButtons = [];
async function openMenu() {
  if (!menuRoot()) {
    const box = document.querySelector('[data-test-selector="community-points-summary"]') || document.querySelector('.community-points-summary'); if (!box) return false;
    (box.querySelector('button') || box).click(); for (let i = 0; i < 25 && !menuRoot(); i++) await pause(200);
  }
  const start = Array.from(document.querySelectorAll('.reward-center__content button')).find((b) => /get started/i.test(b.textContent)); if (start) { start.click(); await pause(1500); }   // the menu's first-time intro
  return !!menuRoot();
}
async function listMenu() {
  if (!(await openMenu())) return { error: 'Twitch\'s points menu is not available on this channel' };
  const all = document.querySelector('[data-a-target="reward-filter-all"]'); if (all && all.getAttribute('aria-checked') !== 'true') { all.click(); await pause(700); }
  const rewards = [], powers = []; rewardButtons = [];
  menuRoot().querySelectorAll('button').forEach((b) => {
    if (b.getAttribute('role') === 'radio') return;
    const cost = b.querySelector('.reward-icon__cost, [data-a-target="cost"]');
    if (cost) {   // a channel-points reward: the button holds the price, the name sits right after it
      let n = b.nextElementSibling; while (n && !text(n)) n = n.nextElementSibling;
      const name = n && n.tagName === 'P' ? text(n) : text(Array.from((b.parentElement || b).querySelectorAll('p')).find((p) => !b.contains(p)));
      rewards.push({ name, cost: text(cost), disabled: !!b.disabled || b.getAttribute('aria-disabled') === 'true', i: rewardButtons.length }); rewardButtons.push(b); return;
    }
    const ps = b.querySelectorAll('p');   // a power-up: its name and its price in bits
    if (ps.length >= 2 && /^\d[\d.,]*$/.test(text(ps[ps.length - 1]))) powers.push({ name: text(ps[0]), cost: text(ps[ps.length - 1]) });
  });
  return { rewards, powers, balance: balance(), bits: bits() };
}
const redeemButton = () => Array.from(document.querySelectorAll('button')).find((x) => /^\s*redeem/i.test(x.textContent) && x.getAttribute('role') !== 'radio' && x.offsetParent !== null);
const detailNote = () => { const d = Array.from(document.querySelectorAll('[role="dialog"]')).find((x) => x.querySelector('.rewards-popover-header')); if (!d) return ''; const head = text(d.querySelector('.rewards-popover-header')); return text(d).replace(head, '').replace(/\b(Back|Close)\b/g, '').replace(/Redeem\s*[\d.,]+\s*[KMB]?/i, '').replace(/[\d.,]+[KMB]?\d(\.\d+)?x\s*$/i, '').replace(/(Open Emote Picker|Search)\s*$/i, '').trim().slice(0, 140); };
const cleanNote = (t) => (/required/i.test(t) ? 'Not enough channel points for this reward' : t);
async function selectReward(i) {
  const b = rewardButtons[i]; if (!b || !b.isConnected) return { error: 'The list changed: open it again' };
  b.click(); let rb = null; for (let k = 0; k < 15 && !rb; k++) { await pause(200); rb = redeemButton(); if (!rb && trayRoot()) break; }
  if (trayRoot() && !rb) return { ok: true, viaChat: true };   // the reward is sent with a message typed in Twitch's own chat box
  if (!rb) return { error: cleanNote(detailNote()) || 'This reward needs steps that only Twitch\'s page can do' };
  if (rb.disabled) return { error: cleanNote(detailNote()) || 'Twitch will not let you redeem this right now' };
  const input = document.querySelector('[role="dialog"] textarea, [role="dialog"] input[type="text"]');
  return { ok: true, needsInput: !!input, inputLabel: input ? (input.placeholder || input.getAttribute('aria-label') || '') : '', canRedeem: true };
}
async function redeemReward(msg) {
  const rb = redeemButton(); if (!rb || rb.disabled) return { error: 'Twitch will not let you redeem this right now' };
  const input = document.querySelector('[role="dialog"] textarea, [role="dialog"] input[type="text"]');
  if (input && msg) { const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, msg); input.dispatchEvent(new Event('input', { bubbles: true })); await pause(300); }
  rb.click(); await pause(2500); return { ok: true, balance: balance() };
}
function trayRoot() { const mark = document.querySelector('[class*="reward-tray"]'); let r = mark; for (let k = 0; k < 4 && r && r.parentElement; k++) { r = r.parentElement; if (r.querySelectorAll('button').length > 0) break; } return mark ? r : null; }
function closeTray() { const r = trayRoot(), b = r && Array.from(r.querySelectorAll('button')).find((x) => /^close$/i.test(x.getAttribute('aria-label') || x.textContent.trim())); if (b) b.click(); }
async function closeMenu() { closeTray(); await pause(300); const c = Array.from(document.querySelectorAll('.reward-center__content button, [role="dialog"] button')).find((b) => /^close$/i.test(b.getAttribute('aria-label') || b.textContent.trim())); if (c) c.click(); else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return { ok: true }; }
ipcRenderer.on('points:cmd', async (e, id, cmd, arg) => {
  let r; try { r = cmd === 'list' ? await listMenu() : cmd === 'select' ? await selectReward(Number(arg)) : cmd === 'redeem' ? await redeemReward(String(arg || '').slice(0, 500)) : cmd === 'close' ? await closeMenu() : { error: 'Unknown' }; } catch (err) { r = { error: 'Twitch\'s page did not answer' }; }
  ipcRenderer.send('points:reply', id, r);
});

