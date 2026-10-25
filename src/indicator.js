'use strict';

const api = window.pc;
let startedAt = Date.now();
let timer = null;
const bars = [...document.querySelectorAll('#bars i')];
const history = new Array(bars.length).fill(0);

function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

api.onIndicatorStart(({ startedAt: at, language }) => {
  const L = window.I18N[language] || window.I18N.ar;
  document.documentElement.lang = language;
  document.documentElement.dir = L.dir;
  document.getElementById('saveText').textContent = L.indSave;
  document.getElementById('discard').textContent = L.indDiscard;
  startedAt = at;
  history.fill(0);
  clearInterval(timer);
  const tick = () => { document.getElementById('time').textContent = fmt(Date.now() - startedAt); };
  tick();
  timer = setInterval(tick, 250);
});

api.onIndicatorLevel((level) => {
  history.shift();
  history.push(level);
  bars.forEach((b, i) => { b.style.height = `${4 + Math.round(history[i] * 16)}px`; });
});

document.getElementById('save').addEventListener('click', () => api.indicatorAction('stop'));
document.getElementById('discard').addEventListener('click', () => api.indicatorAction('discard'));
