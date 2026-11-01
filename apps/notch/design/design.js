/* Maquette interactive : un bureau macOS simulé et l'encoche openedbot.
   Les données sont dans DATA ; l'état change avec les boutons de scénario. */

const GLYPHS = {
  asterisk: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M10 2v16M2 10h16M4.3 4.3l11.4 11.4M15.7 4.3L4.3 15.7"/></svg>',
  bot: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="6" width="14" height="10" rx="3"/><circle cx="7.5" cy="11" r="1.2" fill="currentColor" stroke="none"/><circle cx="12.5" cy="11" r="1.2" fill="currentColor" stroke="none"/><path d="M10 3v3"/></svg>',
  headset: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 11a6 6 0 0 1 12 0"/><rect x="3" y="10" width="3.5" height="5" rx="1.5"/><rect x="13.5" y="10" width="3.5" height="5" rx="1.5"/><path d="M15 15v1a2 2 0 0 1-2 2h-2"/></svg>',
  gear: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10" cy="10" r="2.5"/><path d="M10 2v2.5M10 15.5V18M2 10h2.5M15.5 10H18M4.3 4.3l1.8 1.8M13.9 13.9l1.8 1.8M4.3 15.7l1.8-1.8M13.9 6.1l1.8-1.8"/></svg>',
  chart: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 16h14M5 13V9M9 13V5M13 13v-3M17 13V7"/></svg>',
};

/* L'anneau d'un bot : la part du budget d'étapes du run en cours (usedSteps/maxSteps), dans la
   couleur de son état. Pas de run : piste seule. */
function progress(b) {
  const r = (b.sessions || []).find(s => s.state === 'busy' || s.state === 'waiting');
  if (r && r.step) { const [a, z] = r.step.split('/').map(Number); return a / z; }
  if ((b.sessions || []).some(s => s.state === 'success')) return 1;
  return 0;
}
function stateColor(b) { return { working: '#fff', waiting: 'var(--waiting)', success: 'var(--ample)', offline: 'var(--critical)' }[b.activity] || 'var(--track)'; }
function stateWord(b) { return { working: 'travaille', waiting: 'attend', success: 'terminé', offline: 'hors ligne' }[b.activity] || 'disponible'; }
function band(f) { return f < .5 ? 'var(--ample)' : f < .7 ? 'var(--watch)' : 'var(--critical)'; }
function pct(f) { return Math.round(f * 100) + '%'; }
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }

const state = { edge: 'right', folded: true, pinned: false, hovered: null, data: null, dialog: null, roster: 3, view: 'sections' };

/* L'avatar du bot : l'artwork WEBP d'openedbot (console openedbot) quand il en a un, sinon le glyphe. */
function avatar(b) { return b.artwork ? `<img src="bots/bot-${b.artwork}.webp" alt="${b.name}">` : GLYPHS[b.glyph]; }

function ringSvg(f, color) {
  const r = 19.1, c = 2 * Math.PI * r;
  return `<svg viewBox="0 0 44 44">
    <circle cx="22" cy="22" r="${r}" fill="none" stroke="var(--track)" stroke-width="5.2"/>
    <circle cx="22" cy="22" r="${r}" fill="none" stroke="${color}" stroke-width="3.2" stroke-linecap="round"
      stroke-dasharray="${(c * Math.min(f, 1)).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 22 22)"/>
  </svg>`;
}
function activitySvg(kind) {
  if (!kind) return '';
  return `<svg class="activity ${kind}" viewBox="0 0 44 44"><circle cx="22" cy="22" r="15.2" fill="none" stroke-width="2" stroke-linecap="round"/></svg>`;
}

function renderNotch() {
  const desk = document.getElementById('desk');
  desk.querySelectorAll('.notch, .pill, .orb, .tip').forEach(n => n.remove());
  const d = state.data;
  const open = !state.folded || state.pinned || d.alwaysOn;

  const pill = el(`<div class="pill edge-${state.edge} ${open ? 'hidden' : ''}"></div>`);
  pill.addEventListener('mouseenter', () => { state.folded = false; renderNotch(); });
  desk.appendChild(pill);

  const notch = el(`<div class="notch edge-${state.edge} ${open ? '' : 'folded'}"><div class="flare a"></div><div class="flare b"></div></div>`);
  for (const item of layoutItems(d)) {
    if (item.type === 'sep') { notch.appendChild(el(`<div class="sep"><span>${item.name}</span><i></i></div>`)); continue; }
    if (item.type === 'bot') { notch.appendChild(botCell(item.index, d.bots[item.index])); continue; }
    if (item.type === 'pile') { notch.appendChild(pileCell(item)); continue; }
    if (item.type === 'more') { notch.appendChild(moreCell(item)); continue; }
  }
  notch.addEventListener('mouseleave', (e) => {
    if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.tip, .dlg, .tray')) return;
    state.hovered = null; removeTip(); removeTray();
    if (!state.pinned && !d.alwaysOn && state.dialog == null) { state.folded = true; renderNotch(); }
  });
  notch.addEventListener('click', (e) => { if (e.target === notch) { state.pinned = !state.pinned; toast(state.pinned ? 'Encoche gardée ouverte' : 'Encoche libérée'); } });
  desk.appendChild(notch);

  const orb = el(`<div class="orb" title="Réglages"></div>`);
  positionOrb(orb, notch);
  if (!open) orb.style.display = 'none';
  orb.addEventListener('click', () => { document.getElementById('settings').scrollIntoView({ behavior: 'smooth' }); toast('Réglages'); });
  desk.appendChild(orb);
  renderMenubar();
}

/* ---------- Dix bots : ce que l'encoche montre selon la vue ---------- */
const ACTIVE = new Set(['working', 'waiting', 'success', 'offline']);
function isAlert(b) { return b.approvals > 0 || b.activity === 'waiting'; }

function layoutItems(d) {
  const bots = d.bots.map((b, index) => ({ b, index }));
  const sections = d.sections && d.sections.length ? d.sections : [{ id: null, name: '' }];
  const bySection = id => bots.filter(x => (x.b.section || null) === id);
  const items = [];
  if (bots.length <= 6 && state.view !== 'active') {
    // Peu de bots : tous les anneaux, un filet entre les sections.
    sections.forEach((s, k) => {
      const list = bySection(s.id); if (!list.length) return;
      if (k > 0 && s.name) items.push({ type: 'sep', name: s.name });
      list.forEach(x => items.push({ type: 'bot', index: x.index }));
    });
    return items;
  }
  if (state.view === 'all') {
    sections.forEach((s, k) => {
      const list = bySection(s.id); if (!list.length) return;
      if (s.name) items.push({ type: 'sep', name: s.name });
      list.forEach(x => items.push({ type: 'bot', index: x.index }));
    });
    return items;
  }
  if (state.view === 'active') {
    const active = bots.filter(x => ACTIVE.has(x.b.activity) || isAlert(x.b));
    active.sort((a, b) => (isAlert(b.b) ? 1 : 0) - (isAlert(a.b) ? 1 : 0));
    active.forEach(x => items.push({ type: 'bot', index: x.index }));
    const rest = bots.filter(x => !active.includes(x));
    if (rest.length) items.push({ type: 'more', count: rest.length, name: 'inactifs', members: rest });
    return items;
  }
  // 'sections' : les alertes en tête, puis une pile par section.
  const promoted = bots.filter(x => isAlert(x.b));
  promoted.forEach(x => items.push({ type: 'bot', index: x.index }));
  if (promoted.length) items.push({ type: 'sep', name: '' });
  sections.forEach(s => {
    const list = bySection(s.id).filter(x => !promoted.includes(x)); if (!list.length) return;
    items.push({ type: 'pile', id: s.id, name: s.name, members: list });
  });
  return items;
}

function botCell(i, b) {
  const cell = el(`<div class="cell ${b.stale ? 'stale' : ''}" data-i="${i}">
    <div class="ring">${ringSvg(progress(b), stateColor(b))}${activitySvg(b.activity)}<div class="glyph">${avatar(b)}</div>${b.approvals ? `<div class="badge">${b.approvals}</div>` : ''}</div>
    <div class="pct name">${b.name}</div></div>`);
  cell.addEventListener('mouseenter', () => { removeTray(); state.hovered = i; renderTip(); });
  cell.addEventListener('click', () => openDialog(i));
  return cell;
}

/* Une pile : l'avancement le plus haut de ses runs, l'activité la plus pressante, le badge cumulé. */
function pileCell(item) {
  const bs = item.members.map(x => x.b);
  const usage = Math.max(...bs.map(progress));
  const stale = bs.every(b => b.stale);
  const act = bs.some(b => b.activity === 'waiting') ? 'waiting' : bs.some(b => b.activity === 'working') ? 'working' : bs.some(b => b.activity === 'offline') ? 'offline' : bs.some(b => b.activity === 'success') ? 'success' : null;
  const approvals = bs.reduce((n, b) => n + (b.approvals || 0), 0);
  const cell = el(`<div class="cell pile ${stale ? 'stale' : ''}" data-pile="${item.id}">
    <div class="ring">${ringSvg(usage, act ? stateColor({ activity: act }) : 'var(--track)')}${activitySvg(act)}<div class="glyph">${bs.slice(0, 3).map(b => `<img src="bots/bot-${b.artwork}.webp" alt="">`).join('')}</div>${approvals ? `<div class="badge">${approvals}</div>` : ''}<div class="count">${bs.length}</div></div>
    <div class="pct">${item.name}</div></div>`);
  cell.addEventListener('mouseenter', () => { removeTip(); state.hovered = null; openTray(cell, item.name, item.members); });
  cell.addEventListener('click', () => openTray(cell, item.name, item.members));
  return cell;
}

function moreCell(item) {
  const cell = el(`<div class="cell more"><div class="ring">+${item.count}</div><div class="pct">${item.name}</div></div>`);
  cell.addEventListener('mouseenter', () => { removeTip(); state.hovered = null; openTray(cell, `${item.count} bots inactifs`, item.members); });
  return cell;
}

function removeTray() { document.querySelectorAll('#desk .tray').forEach(t => t.remove()); }

/* Le plateau : la pile déployée à côté de l'encoche, un bot par ligne, clic → sa fenêtre. */
function openTray(anchor, title, members) {
  removeTray();
  const desk = document.getElementById('desk');
  const word = b => ({ working: 'travaille', waiting: 'attend', success: 'terminé', offline: 'hors ligne' })[b.activity] || 'disponible';
  const tray = el(`<div class="tray"><h5>${title}</h5>${members.map(x => `<div class="row" data-i="${x.index}">
    <div class="ring">${ringSvg(progress(x.b), stateColor(x.b))}<img src="bots/bot-${x.b.artwork}.webp" alt=""></div>
    <div><div class="nm">${x.b.name}</div><div class="st ${x.b.activity || ''}">${word(x.b)}</div></div>
    <div class="pc">${(x.b.sessions.find(s => s.state === 'busy' || s.state === 'waiting') || {}).step || ''}</div></div>`).join('')}</div>`);
  tray.querySelectorAll('.row').forEach(r => r.addEventListener('click', () => { removeTray(); openDialog(+r.dataset.i); }));
  tray.addEventListener('mouseleave', (e) => { if (!(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.notch'))) removeTray(); });
  desk.appendChild(tray);
  requestAnimationFrame(() => {
    const p = desk.getBoundingClientRect(), a = anchor.getBoundingClientRect(), t = tray.getBoundingClientRect();
    const cx = a.left + a.width / 2 - p.left, cy = a.top + a.height / 2 - p.top;
    let x, y;
    if (state.edge === 'right') { x = p.width - 50 - 10 - t.width; y = cy - t.height / 2; }
    else if (state.edge === 'left') { x = 50 + 10; y = cy - t.height / 2; }
    else if (state.edge === 'bottom') { x = cx - t.width / 2; y = p.height - 68 - 10 - t.height; }
    else { x = cx - t.width / 2; y = 68 + 10; }
    y = Math.max(34, Math.min(y, p.height - t.height - 8)); x = Math.max(8, Math.min(x, p.width - t.width - 8));
    tray.style.left = x + 'px'; tray.style.top = y + 'px';
  });
}

function positionOrb(orb, notch) {
  requestAnimationFrame(() => {
    const r = notch.getBoundingClientRect(), p = notch.parentElement.getBoundingClientRect();
    if (state.edge === 'right') { orb.style.right = '8px'; orb.style.top = (r.bottom - p.top + 36) + 'px'; }
    if (state.edge === 'left') { orb.style.left = '8px'; orb.style.top = (r.bottom - p.top + 36) + 'px'; }
    if (state.edge === 'bottom') { orb.style.bottom = '17px'; orb.style.left = (r.right - p.left + 36) + 'px'; }
    if (state.edge === 'top') { orb.style.top = '37px'; orb.style.left = (r.right - p.left + 36) + 'px'; }
  });
}

function removeTip() { document.querySelectorAll('#desk .tip').forEach(t => t.remove()); }

function renderTip() {
  removeTip();
  if (state.hovered == null || state.dialog != null) return;
  const b = state.data.bots[state.hovered];
  const desk = document.getElementById('desk');
  const cell = desk.querySelector(`.cell[data-i="${state.hovered}"] .ring`);
  // Le bot survolé n'a pas d'anneau propre dans cette vue (il est dans une pile) : pas de carte.
  if (!cell) { state.hovered = null; return; }
  const tip = el(`<div class="tip ${state.edge === 'right' ? 'leading' : state.edge === 'left' ? 'trailing' : state.edge === 'bottom' ? 'up' : 'down'}">
    <svg class="tail" viewBox="0 0 28 33"><path d="M0 0 C0 8 10 12 28 16.5 C10 21 0 25 0 33 Z" fill="#000"/></svg>
    <div class="hdr"><div class="glyph">${avatar(b)}</div><div><div class="t">${b.title || b.name}</div><div class="s">${b.subtitle}</div></div></div>
    <div class="block"><div class="row"><span>Runtime ${b.runtime || b.subtitle.split('·')[0].trim()}</span><span class="r ${b.activity === 'offline' ? 'off' : ''}">${b.activity === 'offline' ? 'hors ligne depuis 4 min' : 'connecté · vu il y a 3 s'}</span></div>
      <div class="row"><span>${b.subtitle.split('·').slice(1).join('·').trim()}</span><span class="r">${stateWord(b)}</span></div></div>
    ${b.routine ? `<div class="block"><div class="row"><span>Routine · ${b.routine.name}</span><span class="r">${b.routine.next}</span></div></div>` : ''}
    ${b.sessions.length ? '<hr>' + b.sessions.map(s => `<div class="sess"><div class="row"><span>${s.name}</span><span class="state ${s.state}"><i></i>${s.word}</span></div><div class="row"><span>${s.detail}</span><span class="r">${s.step ? s.step + ' · ' : ''}${s.since}</span></div></div>`).join('') : ''}
    ${b.pending ? `<hr><div class="row"><span><b>${b.pending.tool}</b></span><span class="r">${b.pending.bot}</span></div><div style="font-family:var(--mono);margin:4px 0 0;color:#ddd">${b.pending.command}</div>
      <div class="actions"><button class="no" data-act="deny">Refuser ⌘⌫</button><button class="ok" data-act="allow">Autoriser une fois ↩</button></div>` : ''}
    ${b.composer ? `<div class="composer"><input placeholder="Dire à ${b.name} quoi faire…"><button>↑</button></div>` : ''}
  </div>`);
  tip.addEventListener('mouseleave', () => { state.hovered = null; removeTip(); if (!state.pinned && !state.data.alwaysOn) { state.folded = true; renderNotch(); } });
  tip.querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', () => {
    const act = btn.dataset.act;
    b.pending = null; b.approvals = 0;
    b.sessions.forEach(s => { if (s.state === 'waiting') { s.state = act === 'deny' ? 'success' : 'busy'; s.word = act === 'deny' ? 'refusé' : 'travaille'; s.detail = act === 'deny' ? 'Commande refusée, le run continue sans' : 'Autorisé : ' + s.detail; } });
    b.activity = act === 'deny' ? 'success' : 'working';
    toast(act === 'allow' ? 'Autorisé (choice: once)' : 'Refusé (choice: deny)');
    renderNotch(); renderTip();
  }));
  tip.querySelector('.composer input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) { toast(`Message envoyé à ${b.name}`); b.sessions.unshift({ name: 'Nouvelle conversation', detail: e.target.value, state: 'busy', word: 'travaille', since: '0 s' }); b.activity = 'working'; e.target.value = ''; renderNotch(); renderTip(); }
  });
  desk.appendChild(tip);
  requestAnimationFrame(() => {
    const c = cell.getBoundingClientRect(), p = desk.getBoundingClientRect(), t = tip.getBoundingClientRect();
    const cx = c.left + c.width / 2 - p.left, cy = c.top + c.height / 2 - p.top;
    let x, y;
    if (state.edge === 'right') { x = p.width - 50 - 10 - 28 - t.width; y = cy - t.height / 2; }
    else if (state.edge === 'left') { x = 50 + 10 + 28; y = cy - t.height / 2; }
    else if (state.edge === 'bottom') { x = cx - t.width / 2; y = p.height - 68 - 10 - 28 - t.height; }
    else { x = cx - t.width / 2; y = 68 + 10 + 28; }
    y = Math.max(34, Math.min(y, p.height - t.height - 8)); x = Math.max(8, Math.min(x, p.width - t.width - 8));
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
    const tail = tip.querySelector('.tail');
    if (state.edge === 'right') { tail.style.cssText = `right:-27px;top:${cy - y - 16}px`; }
    if (state.edge === 'left') { tail.style.cssText = `left:-27px;top:${cy - y - 16}px;transform:scaleX(-1)`; }
    if (state.edge === 'bottom') { tail.style.cssText = `bottom:-30px;left:${cx - x - 16}px;transform:rotate(90deg)`; }
    if (state.edge === 'top') { tail.style.cssText = `top:-30px;left:${cx - x - 16}px;transform:rotate(-90deg)`; }
  });
}

/* ---------- Fenêtre de dialogue : clic sur un anneau ---------- */
function closeDialog() { document.querySelectorAll('#desk .dlg').forEach(n => n.remove()); state.dialog = null; }

function openDialog(i) {
  const b = state.data.bots[i];
  if (state.dialog === i) { closeDialog(); return; }
  closeDialog(); removeTip();
  state.dialog = i; state.folded = false;
  const desk = document.getElementById('desk');
  const act = b.activity || 'idle';
  const word = { working: 'travaille', waiting: 'attend ton accord', success: 'terminé', offline: 'runtime hors ligne', idle: 'disponible' }[act];
  const dlg = el(`<div class="dlg">
    <div class="dlg-h"><div class="face ${b.id} ${b.artwork ? 'img' : ''}">${avatar(b)}</div><div class="grow"><b>${b.name}</b><small>${b.subtitle}</small></div><span class="st ${act === 'working' ? 'busy' : act}">${word}</span><button class="x" title="Fermer (Échap)">×</button></div>
    <div class="dlg-t">${b.thread.map(m => `<div class="msg ${m.who}">${m.text}${m.meta ? `<span class="meta">${m.meta}</span>` : ''}</div>`).join('')}
      ${b.pending ? `<div class="msg approval"><div><b>${b.pending.tool}</b> · expire dans 9 min</div><div class="cmd">${b.pending.command}</div><div class="actions"><button class="no" data-act="deny">Refuser ⌘⌫</button><button class="ok" data-act="allow">Autoriser une fois ↩</button></div></div>` : ''}
    </div>
    <div class="dlg-c"><input placeholder="Écrire à ${b.name}…" autofocus><span class="mode">${b.subtitle.split('·').pop().trim()}</span><button title="Envoyer">↑</button></div>
  </div>`);
  dlg.querySelector('.x').addEventListener('click', () => { closeDialog(); renderNotch(); });
  dlg.querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', () => {
    const allow = btn.dataset.act === 'allow';
    b.pending = null; b.approvals = 0; b.activity = allow ? 'working' : 'success';
    b.sessions.forEach(s => { if (s.state === 'waiting') { s.state = allow ? 'busy' : 'success'; s.word = allow ? 'travaille' : 'refusé'; } });
    b.thread.push({ who: 'system', text: allow ? 'Autorisé une fois · POST /api/approvals/…/respond {choice:"once"}' : 'Refusé · {choice:"deny"}' });
    if (allow) b.thread.push({ who: 'tool', text: '<b>shell</b> payments refunds create … → re_demo… succeeded' });
    toast(allow ? 'Autorisé' : 'Refusé'); renderNotch(); state.dialog = null; openDialog(i);
  }));
  const send = () => {
    const input = dlg.querySelector('input'); const text = input.value.trim(); if (!text) return;
    b.thread.push({ who: 'user', text, meta: 'maintenant' });
    b.activity = 'working';
    if (!b.sessions.some(s => s.state === 'busy')) b.sessions.unshift({ name: 'DM · toi', detail: text, state: 'busy', word: 'travaille', since: '0 s' });
    toast(`202 SendMessageAccepted · ${b.name}`);
    renderNotch(); state.dialog = null; openDialog(i);
    setTimeout(() => { if (state.dialog === i) { b.thread.push({ who: 'bot', text: 'Bien reçu, je m’en occupe.', meta: 'maintenant' }); state.dialog = null; openDialog(i); } }, 1400);
  };
  dlg.querySelector('.dlg-c button').addEventListener('click', send);
  dlg.querySelector('input').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); if (e.key === 'Escape') { closeDialog(); renderNotch(); } });
  desk.appendChild(dlg);
  requestAnimationFrame(() => {
    const p = desk.getBoundingClientRect(), t = dlg.getBoundingClientRect();
    const cell = desk.querySelector(`.cell[data-i="${i}"] .ring`).getBoundingClientRect();
    const cx = cell.left + cell.width / 2 - p.left, cy = cell.top + cell.height / 2 - p.top;
    let x, y;
    if (state.edge === 'right') { x = p.width - 50 - 12 - t.width; y = cy - t.height / 2; }
    else if (state.edge === 'left') { x = 50 + 12; y = cy - t.height / 2; }
    else if (state.edge === 'bottom') { x = cx - t.width / 2; y = p.height - 68 - 12 - t.height; }
    else { x = cx - t.width / 2; y = 68 + 12; }
    y = Math.max(36, Math.min(y, p.height - t.height - 8)); x = Math.max(8, Math.min(x, p.width - t.width - 8));
    dlg.style.left = x + 'px'; dlg.style.top = y + 'px';
    const thread = dlg.querySelector('.dlg-t'); thread.scrollTop = thread.scrollHeight;
  });
}

function renderMenubar() {
  const d = state.data;
  const box = document.getElementById('mb-readings');
  if (!d.menuBar) { box.innerHTML = `<span class="reading">${GLYPHS.asterisk.replace('<svg', '<svg width="12" height="12"')}</span>`; return; }
  const shown = d.bots.filter(b => b.menuBar && b.activity).slice(0, 2);
  const pending = d.bots.reduce((n, b) => n + (b.approvals || 0), 0);
  const running = d.bots.filter(b => b.activity === 'working').length;
  box.innerHTML = shown.map(b => `<span class="reading">${b.artwork ? `<img src="bots/bot-${b.artwork}.webp" width="14" height="14" style="vertical-align:-3px">` : ''} ${b.name} · ${stateWord(b)}${(b.sessions.find(s => s.state === 'busy') || {}).step ? ' ' + b.sessions.find(s => s.state === 'busy').step : ''}</span>`).join('<span class="sep">|</span>')
    + `<span class="sep">|</span><span class="reading">${running} en cours</span>` + (pending ? `<span class="sep">|</span><b style="color:var(--waiting)">${pending} à valider</b>` : '');
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}

function setScenario(name) {
  const d = state.data = JSON.parse(JSON.stringify(DATA));
  if (state.roster === 10) { d.bots = JSON.parse(JSON.stringify(ROSTER_10)); d.sections = SECTIONS; }
  SCENARIOS[name](d);
  state.lastScenario = name;
  document.querySelectorAll('[data-scn]').forEach(b => b.classList.toggle('on', b.dataset.scn === name));
  state.folded = (name === 'rest');
  state.hovered = null; removeTip(); removeTray(); closeDialog(); renderNotch();
  if (name === 'approval') { state.hovered = d.bots.findIndex(b => b.pending); setTimeout(renderTip, 500); }
  if (d.announcement) toast(d.announcement);
}

function setEdge(edge) {
  state.edge = edge; document.querySelectorAll('[data-edge]').forEach(b => b.classList.toggle('on', b.dataset.edge === edge));
  removeTip(); closeDialog(); renderNotch();
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-scn]').forEach(b => b.addEventListener('click', () => setScenario(b.dataset.scn)));
  document.querySelectorAll('[data-edge]').forEach(b => b.addEventListener('click', () => setEdge(b.dataset.edge)));
  document.getElementById('mb-toggle').addEventListener('click', () => { DATA.menuBar = !DATA.menuBar; state.data.menuBar = DATA.menuBar; renderMenubar(); });
  document.querySelectorAll('[data-roster]').forEach(b => b.addEventListener('click', () => { state.roster = +b.dataset.roster; document.querySelectorAll('[data-roster]').forEach(x => x.classList.toggle('on', x === b)); setScenario(state.lastScenario || 'working'); }));
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { state.view = b.dataset.view; document.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('on', x === b)); setScenario(state.lastScenario || 'working'); }));
  setScenario('working');
});
