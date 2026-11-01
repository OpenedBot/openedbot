/* Données de la maquette, calquées sur le domaine openedbot :
   un anneau par bot, rempli par la fenêtre fournisseur de SON runtime (RuntimeProviderUsageDto),
   l'arc intérieur par l'état de ses runs (ProductRunStatus), le badge par l'inbox (InboxCountsDto). */

const DATA = {
  alwaysOn: false,
  menuBar: true,
  bots: [
    {
      id: 'support', name: 'Support', glyph: 'headset', artwork: 'explorer', menuBar: true,
      subtitle: 'vps-paris · claude-sonnet-5-5 · mode manuel',
      usage: 0.73, stale: false, activity: 'working', approvals: 0, composer: true,
      windows: [], runtime: 'vps-paris', routine: { name: 'Tri des tickets', next: 'toutes les 30 min' },
      sessions: [
        { name: 'Routine · Tri des tickets', detail: '4,2k tokens', step: '3/8', state: 'busy', word: 'travaille', since: '1 min' },
        { name: 'DM · Léa (client #4821)', detail: 'Répondu il y a 6 min', state: 'success', word: 'terminé', since: '6 min' },
      ],
      pending: null,
      thread: [
        { who: 'system', text: 'Routine « Tri des tickets » lancée à 13:41' },
        { who: 'tool', text: '<b>zendesk.list_tickets</b> status=open · 14 résultats' },
        { who: 'bot', text: 'Je trie les 14 tickets ouverts. Deux concernent des remboursements, je les traite en priorité.', meta: '13:41' },
        { who: 'tool', text: '<b>zendesk.update</b> #4819 → tag:billing · #4821 → tag:refund' },
        { who: 'user', text: 'Pour #4821, vérifie d’abord que la commande a bien été livrée en retard.', meta: '13:42' },
        { who: 'bot', text: 'Livraison prévue le 3, reçue le 9 : six jours de retard, le remboursement est justifié selon la politique « retard > 5 j ».', meta: '13:42' },
      ],
    },
    {
      id: 'ops', name: 'Ops', glyph: 'gear', artwork: 'mecha', menuBar: true,
      subtitle: 'homelab-01 · gpt-5-codex · mode auto',
      usage: 0.21, stale: false, activity: 'success', approvals: 0, composer: true,
      windows: [], runtime: 'homelab-01', routine: { name: 'Veille infra', next: 'dans 2 h 18' },
      sessions: [
        { name: 'Routine · Veille infra', detail: 'Prochain passage dans 2 h 18', state: 'success', word: 'terminé', since: '4 min' },
      ],
      pending: null,
      thread: [
        { who: 'system', text: 'Routine « Veille infra » · passage de 13:38' },
        { who: 'tool', text: '<b>ssh.run</b> homelab-01 · df -h / && uptime' },
        { who: 'bot', text: 'Rien à signaler : disque à 61 %, charge 0,42, aucun service en erreur. Prochain passage dans 2 h 18.', meta: '13:38' },
      ],
    },
    {
      id: 'growth', name: 'Growth', glyph: 'chart', artwork: 'comet', menuBar: false,
      subtitle: 'gpu-box · gemma-4 (local) · mode plan',
      usage: 0.52, stale: false, activity: null, approvals: 0, composer: true,
      windows: [], runtime: 'gpu-box',
      sessions: [
        { name: 'Groupe · Newsletter', detail: 'Brouillon relu, en attente de Léa', state: 'idle', word: 'inactif', since: '38 min' },
      ],
      pending: null,
      thread: [
        { who: 'user', text: 'Prépare la newsletter d’octobre à partir des 3 derniers changelogs.', meta: '13:04' },
        { who: 'bot', text: 'Brouillon prêt (412 mots, 3 sections). Je l’ai partagé dans le groupe « Newsletter », en attente de la relecture de Léa.', meta: '13:12' },
      ],
    },
  ],
};

const SCENARIOS = {
  rest(d) {
    d.bots.forEach(b => { b.activity = null; b.sessions.forEach(s => { s.state = 'idle'; s.word = 'inactif'; }); });
  },
  working(d) { /* état par défaut : Support travaille, Ops vient de finir */ },
  approval(d) {
    const b = d.bots[0];
    b.activity = 'waiting'; b.approvals = 1;
    b.sessions.unshift({ name: 'DM · Léa (client #4821)', detail: 'Rembourser la commande 4821 ?', state: 'waiting', word: 'attend', since: '12 s' });
    b.sessions.splice(2, 1);
    b.pending = { tool: 'shell', bot: 'Support', command: 'payments refunds create --charge ch_demo… --amount 4900' };
    b.thread.push({ who: 'bot', text: 'Je lance le remboursement de 49,00 € pour la commande 4821. Il me faut ton accord pour la commande de paiement.', meta: '13:42' });
  },
  done(d) {
    const b = d.bots[0];
    b.activity = 'success';
    b.sessions[0] = { name: 'Routine · Tri des tickets', detail: '8 tickets triés, 2 escaladés', state: 'success', word: 'terminé', since: '2 s' };
    b.thread.push({ who: 'bot', text: 'Terminé : 8 tickets triés, 2 escaladés à l’équipe facturation. Récapitulatif posté dans le fil.', meta: '13:43' });
    d.announcement = 'Support a terminé « Tri des tickets »';
  },
  offline(d) {
    const b = d.bots[2];
    b.stale = true; b.activity = 'offline';
    b.subtitle = 'gpu-box · hors ligne depuis 4 min · connecteur 1.4.2 → 1.5.0';
    b.sessions[0] = { name: 'Groupe · Newsletter', detail: 'En attente du runtime (link_down)', state: 'offline', word: 'hors ligne', since: '4 min' };
  },
};

/* ---------- Roster à dix bots, en sections (RosterDto.sections) ---------- */
function mkBot(id, name, artwork, section, usage, opts = {}) {
  return {
    id, name, glyph: 'bot', artwork, section, menuBar: false,
    subtitle: opts.subtitle || `${opts.runtime || 'vps-paris'} · ${opts.model || 'claude-sonnet-5-5'} · mode ${opts.mode || 'manuel'}`,
    usage, stale: !!opts.stale, activity: opts.activity || null, approvals: opts.approvals || 0, composer: true,
    windows: [], runtime: opts.runtime || 'vps-paris', routine: opts.routine || null,
    sessions: opts.sessions || [],
    pending: opts.pending || null,
    thread: opts.thread || [{ who: 'system', text: 'Aucune conversation récente.' }],
  };
}

const SECTIONS = [
  { id: 'clients', name: 'Clients' },
  { id: 'interne', name: 'Interne' },
  { id: 'perso', name: 'Perso' },
];

const ROSTER_10 = [
  Object.assign(JSON.parse(JSON.stringify(DATA.bots[0])), { section: 'clients' }),
  mkBot('sales', 'Sales', 'samurai', 'clients', 0.73, { sessions: [{ name: 'DM · Devis Acme', detail: 'Relance envoyée', state: 'success', word: 'terminé', since: '18 min' }] }),
  mkBot('onboarding', 'Onboarding', 'halo', 'clients', 0.73, { activity: 'working', sessions: [{ name: 'Routine · Bienvenue J+1', detail: 'E-mail de bienvenue', step: '2/4', state: 'busy', word: 'travaille', since: '40 s' }] }),
  Object.assign(JSON.parse(JSON.stringify(DATA.bots[1])), { section: 'interne' }),
  Object.assign(JSON.parse(JSON.stringify(DATA.bots[2])), { section: 'interne' }),
  mkBot('data', 'Data', 'orbit', 'interne', 0.21, { runtime: 'homelab-01', model: 'gpt-5-codex', mode: 'auto', reset: 'Réinit. dans 2 h 59', short: '2h 59m' }),
  mkBot('assistant', 'Assistant', 'bloom', 'perso', 0.12, { runtime: 'mac-studio', model: 'gemma-4 (local)', mode: 'auto', reset: 'Réinit. 00:00', short: '10h' }),
  mkBot('veille', 'Veille', 'stealth', 'perso', 0.12, { runtime: 'mac-studio', model: 'gemma-4 (local)', mode: 'auto', reset: 'Réinit. 00:00', short: '10h', activity: 'success', sessions: [{ name: 'Routine · Revue HN', detail: '6 liens retenus', state: 'success', word: 'terminé', since: '9 min' }] }),
  mkBot('recherche', 'Recherche', 'astral', 'perso', 0.12, { runtime: 'mac-studio', model: 'gemma-4 (local)', mode: 'auto', reset: 'Réinit. 00:00', short: '10h' }),
  mkBot('notes', 'Notes', 'cloud', 'perso', 0.12, { runtime: 'mac-studio', model: 'gemma-4 (local)', mode: 'auto', reset: 'Réinit. 00:00', short: '10h' }),
];
