/**
 * Recette HTTP du guichet de support, sans navigateur.
 *
 * Elle prouve la seule chose qu'un typecheck ne peut pas prouver : qu'une
 * trame part réellement d'un côté et ARRIVE de l'autre. Le reste (refus
 * d'adresse, bornes, curseurs) est couvert par `apps/api/tests/support-desk.test.ts`.
 *
 * Ce qui est joué, dans l'ordre :
 *
 *  1. un visiteur ouvre un fil, et reçoit son jeton UNE fois ;
 *  2. le flux staff est ouvert, puis le visiteur écrit : la trame arrive ;
 *  3. le flux invité est ouvert, puis le staff répond : la trame arrive ;
 *  4. le même POST rejoué avec la même clé d'idempotence ne double pas, et une
 *     CAPTURE jointe fait l'aller-retour complet : octets rangés, fichier
 *     servi aux deux portes, refusé à un jeton étranger, non-image refusée ;
 *  5. un autre jeton n'ouvre rien, et ne dit pas si le fil existe ;
 *  6. le staff clôt, un message du visiteur réouvre ;
 *  7. un OPÉRATEUR CONNECTÉ ouvre un fil sans donner d'adresse : c'est celle
 *     de son compte que le serveur retient ;
 *  8. l'HISTORIQUE suit ce compte sans aucun jeton, le compteur de non-lus du
 *     visiteur monte quand le staff répond et retombe à la lecture, et le rail
 *     du backoffice compte les demandes en attente ;
 *  9. les fils créés sont EFFACÉS, quoi qu'il arrive.
 *
 * Aucun modèle n'est appelé : le guichet est humain de bout en bout.
 */

import { passwordLogin } from "../../scripts/lib/password-login";

const baseUrl = (process.env.E2E_API_URL ?? "http://127.0.0.1:8790").replace(/\/+$/, "");
const staffEmail = process.env.DEV_STAFF_EMAIL ?? "staff@ohb.dev";
/** Le compte opérateur semé par `make db-seed`, pour l'étape 7. */
const operatorEmail = process.env.E2E_EMAIL ?? "dev@ohb.local";
const operatorPassword = process.env.E2E_PASSWORD || (() => { throw new Error("E2E_PASSWORD is not set: run `make setup` (it generates one in .env.local), or export it."); })();
/**
 * Une adresse par exécution : un fil, jamais deux exécutions dans le même.
 *
 * Le domaine doit réellement recevoir du courrier : la route refuse un domaine
 * sans MX (`SUPPORT_EMAIL_DOMAIN_UNKNOWN`), et `example.com` n'en a pas. Rien
 * n'est jamais envoyé à cette adresse : le guichet ne notifie que le STAFF,
 * jamais le visiteur. Le domaine reste réglable pour une recette qui préfère
 * le sien.
 */
const guestDomain = process.env.E2E_SUPPORT_EMAIL_DOMAIN ?? "gmail.com";
const guestEmail = `e2e-support-${Date.now()}@${guestDomain}`;

const TRAME_TIMEOUT_MS = 15_000;

function step(label: string): void {
  console.log(`  ${label}`);
}

function fail(message: string): never {
  throw new Error(message);
}

async function readError(response: Response): Promise<string> {
  return `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`;
}

/**
 * Ouvre (ou rejoint) un fil, en respectant le plafond de la route.
 *
 * `POST /api/support/conversations` est plafonné à TROIS par minute et par IP :
 * quelqu'un qui a besoin d'aide en ouvre un, pas trente. Cette recette en
 * demande quatre, et deux passes de suite partagent la même fenêtre. Sans ce
 * rattrapage, elle échouait sur un 429 qui ne dit rien du produit, et
 * `make e2e-support` deux fois d'affilée était rouge la seconde fois.
 *
 * Une seule attente, celle que le serveur nomme lui-même (`Retry-After`) : si
 * le second essai est encore refusé, c'est un vrai refus et il remonte.
 */
async function openConversation(init: RequestInit): Promise<Response> {
  const first = await fetch(`${baseUrl}/api/support/conversations`, init);
  if (first.status !== 429) return first;
  const wait = Number(first.headers.get("Retry-After") ?? "60");
  const seconds = Number.isFinite(wait) && wait > 0 ? Math.min(wait, 75) : 60;
  step(`plafond d'ouverture atteint : attente de ${seconds + 1} s (3 par minute)`);
  await new Promise((resolve) => setTimeout(resolve, (seconds + 1) * 1_000));
  return fetch(`${baseUrl}/api/support/conversations`, init);
}

/* --------------------------- la session staff ----------------------------- */

const health = await fetch(`${baseUrl}/api/health`);
if (!health.ok) fail(`Santé de l'API : ${await readError(health)}`);

const staffCode = await fetch(`${baseUrl}/api/pro/staff/login/code`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: staffEmail }),
});
if (!staffCode.ok) fail(`Code staff : ${await readError(staffCode)}`);
const staffCodeBody = await staffCode.json() as { devCode?: string };
if (!staffCodeBody.devCode) {
  fail("Code staff : la réponse ne porte pas devCode. L’API locale doit tourner en développement.");
}
const staffLogin = await fetch(`${baseUrl}/api/pro/staff/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: staffEmail, code: staffCodeBody.devCode }),
});
if (!staffLogin.ok) fail(`Connexion staff : ${await readError(staffLogin)}`);
const staffBody = await staffLogin.json() as { csrfToken?: string; user?: { id?: string } };
const staffCookie = (staffLogin.headers.get("set-cookie") ?? "")
  .split(",")
  .map((part) => part.trim().split(";")[0])
  .filter(Boolean)
  .join("; ");
if (!staffCookie || !staffBody.csrfToken) fail("La connexion staff n'a rendu ni cookie ni jeton CSRF.");
const staffHeaders = { Cookie: staffCookie, "X-CSRF-Token": staffBody.csrfToken };
step(`session staff ouverte pour ${staffEmail}`);

/* ------------------------- 1. le visiteur ouvre --------------------------- */

const opened = await openConversation({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: guestEmail, locale: "fr" }),
});
if (opened.status !== 201) fail(`Ouverture du fil : ${await readError(opened)}`);
const openedBody = await opened.json() as {
  conversationId?: string;
  token?: string;
  snapshot?: { cursor?: number; status?: string; messages?: unknown[] };
};
const conversationId = openedBody.conversationId;
const guestToken = openedBody.token;
if (!conversationId || !guestToken) fail("L'ouverture n'a rendu ni identifiant de fil ni jeton.");
if (openedBody.snapshot?.status !== "open") fail("Un fil neuf devrait être ouvert.");
if ((openedBody.snapshot?.messages ?? []).length !== 0) fail("Un fil neuf ne devrait porter aucun message.");
const guestHeaders = { "X-OpenedBot-Support-Token": guestToken, "Content-Type": "application/json" };
/** Tout fil créé par cette passe, effacé dans le `finally` quoi qu'il arrive. */
const created: string[] = [conversationId];
step(`fil ${conversationId} ouvert pour ${guestEmail}`);

try {
  /* ------------------- le lecteur de flux, pour les deux ------------------ */

  type Frame = { event: string | null; data: Record<string, unknown> };

  /**
   * Ouvre un flux et rend une promesse qui se résout sur la PREMIÈRE trame
   * satisfaisant le prédicat. Le flux est ouvert AVANT l'écriture qu'il doit
   * observer : c'est tout l'objet de la preuve, une trame reçue après coup ne
   * dirait pas si elle a été poussée ou rejouée.
   */
  async function awaitFrame(input: {
    url: string;
    headers: Record<string, string>;
    label: string;
    matches: (frame: Frame) => boolean;
    trigger: () => Promise<void>;
  }): Promise<Frame> {
    const controller = new AbortController();
    const response = await fetch(input.url, {
      headers: { ...input.headers, Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) fail(`${input.label} : ${await readError(response)}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("text/event-stream")) {
      fail(`${input.label} : le flux répond « ${contentType} » et non « text/event-stream ».`);
    }
    if ((response.headers.get("content-encoding") ?? "") !== "") {
      fail(`${input.label} : le flux est compressé, ce qui retiendrait chaque trame dans le compresseur.`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let triggered = false;
    const deadline = Date.now() + TRAME_TIMEOUT_MS;

    try {
      while (Date.now() < deadline) {
        const read = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>((resolve) =>
            setTimeout(() => resolve({ value: undefined, done: true }), Math.max(0, deadline - Date.now())),
          ),
        ]);
        if (read.value) buffer += decoder.decode(read.value, { stream: true });

        // Le commentaire « : connected » dit que l'abonnement est en place.
        // C'est SEULEMENT là que l'écriture peut partir : la déclencher avant
        // laisserait la trame passer sans personne pour l'attendre.
        if (!triggered && buffer.includes(": connected")) {
          triggered = true;
          await input.trigger();
        }

        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          const lines = raw.split("\n");
          const data = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          const name = lines.find((line) => line.startsWith("event:"));
          const frame: Frame = {
            event: name ? name.slice(6).trim() : null,
            data: JSON.parse(data) as Record<string, unknown>,
          };
          if (input.matches(frame)) return frame;
        }
        if (read.done) break;
      }
    } finally {
      controller.abort();
    }
    fail(`${input.label} : aucune trame attendue en ${TRAME_TIMEOUT_MS} ms.`);
  }

  /* ------- 2. le visiteur écrit, le flux STAFF doit le voir arriver ------- */

  const guestText = "Bonjour, je n'arrive pas à connecter mon runtime.";
  const staffFrame = await awaitFrame({
    url: `${baseUrl}/api/pro/staff/support/events?cursor=${openedBody.snapshot?.cursor ?? 0}`,
    headers: staffHeaders,
    label: "Flux staff",
    matches: (frame) =>
      frame.event === "support.message"
      && frame.data.conversationId === conversationId
      && (frame.data.payload as { author?: string } | undefined)?.author === "guest",
    trigger: async () => {
      const sent = await fetch(`${baseUrl}/api/support/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { ...guestHeaders, "Idempotency-Key": "e2e-support-guest-message-1" },
        body: JSON.stringify({ body: guestText }),
      });
      if (sent.status !== 201) fail(`Message du visiteur : ${await readError(sent)}`);
    },
  });
  if ((staffFrame.data.payload as { body?: string }).body !== guestText) {
    fail("La trame staff ne porte pas le texte du visiteur.");
  }
  if (typeof staffFrame.data.cursor !== "number" || staffFrame.data.cursor <= 0) {
    fail("La trame staff n'a pas de curseur exploitable comme Last-Event-ID.");
  }
  step("le message du visiteur est arrivé sur le flux staff");

  /* ------ 3. le staff répond, le flux INVITÉ doit le voir arriver -------- */

  const snapshot = await fetch(`${baseUrl}/api/support/conversations/${conversationId}`, { headers: guestHeaders });
  if (!snapshot.ok) fail(`Instantané du visiteur : ${await readError(snapshot)}`);
  const snapshotBody = await snapshot.json() as { cursor: number; messages: Array<{ author: string }> };
  if (snapshotBody.messages.length !== 1) {
    fail(`L'instantané du visiteur porte ${snapshotBody.messages.length} message(s), un attendu.`);
  }

  const staffText = "Bonjour, on regarde tout de suite.";
  const guestFrame = await awaitFrame({
    url: `${baseUrl}/api/support/conversations/${conversationId}/events?cursor=${snapshotBody.cursor}`,
    headers: guestHeaders,
    label: "Flux invité",
    matches: (frame) =>
      frame.event === "support.message"
      && (frame.data.payload as { author?: string } | undefined)?.author === "staff",
    trigger: async () => {
      const replied = await fetch(`${baseUrl}/api/pro/staff/support/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { ...staffHeaders, "Content-Type": "application/json", "Idempotency-Key": "e2e-support-staff-reply-1" },
        body: JSON.stringify({ body: staffText }),
      });
      if (replied.status !== 201) fail(`Réponse du staff : ${await readError(replied)}`);
    },
  });
  if ((guestFrame.data.payload as { body?: string }).body !== staffText) {
    fail("La trame invité ne porte pas le texte du staff.");
  }
  step("la réponse du staff est arrivée sur le flux invité");

  /* --------------------- 4. le rejeu ne double pas ----------------------- */

  const replay = await fetch(`${baseUrl}/api/support/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { ...guestHeaders, "Idempotency-Key": "e2e-support-guest-message-1" },
    body: JSON.stringify({ body: guestText }),
  });
  if (replay.status !== 201) fail(`Rejeu du message du visiteur : ${await readError(replay)}`);
  const replayBody = await replay.json() as { messages: Array<{ author: string; body: string }> };
  const guestMessages = replayBody.messages.filter((message) => message.author === "guest");
  if (guestMessages.length !== 1) {
    fail(`Le rejeu a produit ${guestMessages.length} message(s) du visiteur, un attendu.`);
  }
  step("le POST rejoué avec la même clé n'a rien dupliqué");

  /* ------------- 4b. la capture du bug : octets et service -------------- */

  // Un PNG d'un pixel, transparent : le plus petit fichier valide possible.
  // Ce qui est éprouvé ici n'est pas l'image, c'est le chemin complet : le
  // client encode, la route range les octets dans le magasin de blobs, la
  // ligne ne garde que l'identité, et la route de service rend le fichier à
  // qui ouvre la bonne porte.
  const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
  const withImage = await fetch(`${baseUrl}/api/support/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { ...guestHeaders, "Idempotency-Key": "e2e-support-guest-image-1" },
    body: JSON.stringify({
      body: "Voici la capture **du bug**.",
      attachments: [{
        name: "capture.png",
        contentType: "image/png",
        kind: "image",
        content: [{ type: "image", image: `data:image/png;base64,${pixel}` }],
      }],
    }),
  });
  if (withImage.status !== 201) fail(`Message avec capture : ${await readError(withImage)}`);
  const withImageBody = await withImage.json() as {
    messages: Array<{ body: string; attachments?: Array<{ id: string; name: string; contentType: string; bytes: number }> }>;
  };
  const illustrated = withImageBody.messages.find((message) => (message.attachments ?? []).length > 0);
  const file = illustrated?.attachments?.[0];
  if (!file) fail("Le message rendu ne porte aucune capture.");
  if (file.name !== "capture.png" || file.contentType !== "image/png") {
    fail(`La capture rendue s'appelle « ${file.name} » (${file.contentType}).`);
  }
  if (file.bytes < 60) fail(`La capture ne pèse que ${file.bytes} octets : les octets n'ont pas été décodés.`);

  const served = await fetch(`${baseUrl}/api/support/attachments/${file.id}`, { headers: guestHeaders });
  if (!served.ok) fail(`Service de la capture au visiteur : ${await readError(served)}`);
  if (served.headers.get("content-type") !== "image/png") {
    fail(`La capture est servie en « ${served.headers.get("content-type")} ».`);
  }
  const servedBytes = new Uint8Array(await served.arrayBuffer());
  if (servedBytes.byteLength !== file.bytes) {
    fail(`La capture servie pèse ${servedBytes.byteLength} octets, ${file.bytes} attendus.`);
  }
  // La signature PNG, pour être sûr que ce sont bien les octets envoyés et non
  // une page d'erreur déguisée en image.
  if (servedBytes[0] !== 0x89 || servedBytes[1] !== 0x50) fail("Les octets servis ne sont pas un PNG.");

  // Le staff lit la MÊME capture par sa propre porte.
  const staffFile = await fetch(`${baseUrl}/api/pro/staff/support/attachments/${file.id}`, {
    headers: staffHeaders,
  });
  if (!staffFile.ok) fail(`Service de la capture au staff : ${await readError(staffFile)}`);

  // Un jeton étranger ne l'obtient pas, et la réponse ne dit pas qu'elle
  // existe : c'est la RLS du fil parent qui décide, pas un `where`.
  const stranger = await fetch(`${baseUrl}/api/support/attachments/${file.id}`, {
    headers: { "X-OpenedBot-Support-Token": `etranger-${"0".repeat(24)}` },
  });
  if (stranger.status !== 404) {
    fail(`Un jeton étranger obtient HTTP ${stranger.status} sur la capture, 404 attendu.`);
  }

  // Un fichier qui n'est pas une image est refusé, et le refus est NOMMÉ : ce
  // guichet affiche ce qu'il reçoit, donc il doit savoir l'afficher.
  const refused = await fetch(`${baseUrl}/api/support/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: guestHeaders,
    body: JSON.stringify({
      body: "et un journal",
      attachments: [{
        name: "journal.txt",
        contentType: "text/plain",
        kind: "document",
        content: [{ type: "text", text: "une ligne" }],
      }],
    }),
  });
  if (refused.status !== 400 && refused.status !== 415) {
    fail(`Une pièce jointe non-image obtient HTTP ${refused.status}, un refus attendu.`);
  }
  step(`la capture de ${file.bytes} octets est rangée, servie aux deux portes, et refusée aux autres`);

  /* -------------- 5. un autre jeton n'ouvre rien du tout ---------------- */

  const foreign = await fetch(`${baseUrl}/api/support/conversations/${conversationId}`, {
    headers: { "X-OpenedBot-Support-Token": "ce-jeton-nouvre-rien-du-tout-0123456789" },
  });
  if (foreign.status !== 404) {
    fail(`Un jeton étranger obtient HTTP ${foreign.status}, 404 attendu (et surtout pas 200).`);
  }
  const noToken = await fetch(`${baseUrl}/api/support/conversations/${conversationId}`);
  if (noToken.status !== 401) {
    fail(`Une requête sans jeton obtient HTTP ${noToken.status}, 401 attendu.`);
  }
  step("un jeton étranger ne lit rien, et la réponse ne dit pas si le fil existe");

  /* ------------- 6. clore, puis un message du visiteur réouvre ----------- */

  const closed = await fetch(`${baseUrl}/api/pro/staff/support/conversations/${conversationId}/close`, {
    method: "POST",
    headers: staffHeaders,
  });
  if (!closed.ok) fail(`Clôture du fil : ${await readError(closed)}`);
  const closedBody = await closed.json() as { conversation: { status: string } };
  if (closedBody.conversation.status !== "closed") fail("Le fil n'est pas passé à l'état clos.");

  const reopen = await fetch(`${baseUrl}/api/support/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { ...guestHeaders, "Idempotency-Key": "e2e-support-guest-message-2" },
    body: JSON.stringify({ body: "Rebonjour, j'ai une autre question." }),
  });
  if (reopen.status !== 201) fail(`Message de réouverture : ${await readError(reopen)}`);
  const reopenBody = await reopen.json() as { status: string };
  if (reopenBody.status !== "open") fail("Un message du visiteur devrait réouvrir un fil clos.");
  step("un message du visiteur a bien réouvert le fil clos");

  /* ------------ la liste du staff voit le fil et son attente ------------- */

  const list = await fetch(`${baseUrl}/api/pro/staff/support/conversations?status=open&limit=50`, {
    headers: staffHeaders,
  });
  if (!list.ok) fail(`Liste du staff : ${await readError(list)}`);
  const listBody = await list.json() as {
    conversations: Array<{ id: string; email: string; unreadCount: number; lastMessageAuthor: string | null }>;
    total: number;
  };
  const row = listBody.conversations.find((conversation) => conversation.id === conversationId);
  if (!row) fail("Le fil n'apparaît pas dans la liste des fils ouverts du staff.");
  if (row.email !== guestEmail) fail("La ligne d'inbox ne porte pas l'adresse du visiteur.");
  if (row.lastMessageAuthor !== "guest") fail("La ligne d'inbox devrait dire que le visiteur a parlé en dernier.");
  if (row.unreadCount < 1) fail("La ligne d'inbox devrait compter au moins un message non lu.");
  step(`la liste du staff porte le fil, ${row.unreadCount} non lu(s)`);

  /* ------- 7. un opérateur connecté n'a aucune adresse à redonner -------- */

  const operatorLogin = await passwordLogin(baseUrl, { email: operatorEmail, password: operatorPassword });
  if (!operatorLogin.ok) fail(`Connexion opérateur : ${await readError(operatorLogin)}`);
  const operatorBody = await operatorLogin.json() as { csrfToken?: string };
  const operatorCookie = (operatorLogin.headers.get("set-cookie") ?? "")
    .split(",")
    .map((part) => part.trim().split(";")[0])
    .filter(Boolean)
    .join("; ");
  if (!operatorCookie || !operatorBody.csrfToken) fail("La connexion opérateur n'a rendu ni cookie ni jeton CSRF.");

  const identified = await openConversation({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: operatorCookie,
      "X-CSRF-Token": operatorBody.csrfToken,
    },
    // AUCUNE adresse : c'est tout le point. Et un premier message, parce que
    // sur ce chemin rien d'autre ne marque l'intention d'écrire.
    //
    // `fresh` est indispensable ICI, et pour deux raisons. La recette doit
    // être déterministe : sans lui, la route REJOINT le dernier fil du compte
    // (c'est son travail depuis 0078) et l'ouverture rend 200 au lieu de 201
    // selon l'histoire de la base. Et surtout, l'effacement de l'étape 9 ne
    // doit emporter QUE des fils que cette recette a créés : rejoindre le fil
    // d'un vrai opérateur puis le supprimer serait une perte de données.
    body: JSON.stringify({ locale: "fr", fresh: true, body: "Bonjour, une question sur mon abonnement." }),
  });
  if (identified.status !== 201) fail(`Ouverture par un opérateur connecté : ${await readError(identified)}`);
  const identifiedBody = await identified.json() as {
    conversationId?: string;
    snapshot?: { email?: string; messages?: Array<{ author: string; body: string }> };
  };
  if (!identifiedBody.conversationId) fail("L'ouverture par un opérateur n'a rendu aucun identifiant de fil.");
  created.push(identifiedBody.conversationId);
  if (identifiedBody.snapshot?.email !== operatorEmail) {
    fail(
      `Le fil porte « ${identifiedBody.snapshot?.email} » au lieu de l'adresse du compte « ${operatorEmail} » : `
      + "l'identité doit venir de la session, pas du corps de la requête.",
    );
  }
  if ((identifiedBody.snapshot?.messages ?? []).length !== 1) {
    fail("Le premier message de l'opérateur n'est pas dans le fil qu'il vient d'ouvrir.");
  }

  // Sans `fresh`, le MÊME appel rejoint ce fil au lieu d'en ouvrir un second.
  // C'est ce qui empêche une nouvelle machine, ou un navigateur nettoyé, de
  // laisser derrière lui une file de fils vides et une équipe réveillée deux
  // fois pour la même personne.
  const rejoined = await openConversation({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: operatorCookie,
      "X-CSRF-Token": operatorBody.csrfToken,
    },
    body: JSON.stringify({ locale: "fr", body: "J'ajoute une précision." }),
  });
  if (rejoined.status !== 200) {
    fail(`Un second envoi sans « fresh » obtient HTTP ${rejoined.status}, 200 attendu (fil rejoint).`);
  }
  const rejoinedBody = await rejoined.json() as {
    conversationId?: string;
    token?: string;
    snapshot?: { messages?: unknown[] };
  };
  if (rejoinedBody.conversationId !== identifiedBody.conversationId) {
    fail("Un second envoi a ouvert un NOUVEAU fil au lieu de rejoindre celui du compte.");
  }
  if (rejoinedBody.token !== "") {
    fail("Le fil rejoint rend un jeton : c'est la session qui l'ouvre, il n'y a aucun secret à remettre.");
  }
  if ((rejoinedBody.snapshot?.messages ?? []).length !== 2) {
    fail("Le second message n'a pas rejoint le fil existant.");
  }

  // Une ouverture SANS session et SANS adresse doit être refusée, et nommée :
  // c'est ce code qui fait retomber le panneau sur la porte e-mail.
  const anonymous = await openConversation({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ locale: "fr", body: "sans adresse ni session" }),
  });
  if (anonymous.status !== 400) {
    fail(`Une ouverture sans session ni adresse obtient HTTP ${anonymous.status}, 400 attendu.`);
  }
  const anonymousBody = await anonymous.json() as { error?: { code?: string } };
  if (anonymousBody.error?.code !== "SUPPORT_EMAIL_REQUIRED") {
    fail(`Le refus est « ${anonymousBody.error?.code} » au lieu de SUPPORT_EMAIL_REQUIRED.`);
  }
  step(`l'opérateur connecté a ouvert son fil sous ${operatorEmail}, sans rien retaper`);

  /* ------ 8. l'historique suit le COMPTE, et le compteur de non-lus ----- */

  const accountThreadId = identifiedBody.conversationId;
  // Sans le moindre jeton : c'est la porte COMPTE (0078) qui répond, celle qui
  // permet de retrouver son fil depuis une autre machine.
  const history = await fetch(`${baseUrl}/api/support/conversations`, {
    headers: { Cookie: operatorCookie },
  });
  if (!history.ok) fail(`Historique de l'opérateur : ${await readError(history)}`);
  const historyBody = await history.json() as {
    conversations: Array<{ conversationId: string; unreadCount: number; cursor: number }>;
  };
  const mine = historyBody.conversations.find((thread) => thread.conversationId === accountThreadId);
  if (!mine) fail("L'historique de l'opérateur ne contient pas le fil qu'il vient d'ouvrir.");
  if (mine.cursor <= 0) fail("La ligne d'historique ne porte pas de curseur : la bulle rejouerait le fil.");

  // Un visiteur ANONYME ne voit pas ce fil : l'historique sans jeton ni
  // session est vide, et ne dit pas qu'un fil existe.
  const strangerHistory = await fetch(`${baseUrl}/api/support/conversations`);
  if (!strangerHistory.ok) fail(`Historique sans porte : ${await readError(strangerHistory)}`);
  const strangerBody = await strangerHistory.json() as { conversations: unknown[] };
  if (strangerBody.conversations.length !== 0) {
    fail("Un appelant sans jeton ni session reçoit un historique NON vide.");
  }

  const staffAnswer = await fetch(
    `${baseUrl}/api/pro/staff/support/conversations/${accountThreadId}/messages`,
    {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({ body: "On regarde votre abonnement." }),
    },
  );
  if (staffAnswer.status !== 201) fail(`Réponse du staff au fil du compte : ${await readError(staffAnswer)}`);

  const accountSnapshot = await fetch(`${baseUrl}/api/support/conversations/${accountThreadId}`, {
    headers: { Cookie: operatorCookie },
  });
  if (!accountSnapshot.ok) fail(`Instantané par la session : ${await readError(accountSnapshot)}`);
  const accountBody = await accountSnapshot.json() as {
    unreadCount?: number;
    messages?: Array<{ author: string; body: string }>;
  };
  if (!(accountBody.messages ?? []).some((message) => message.author === "staff")) {
    fail("La réponse du staff n'est pas dans le fil lu par la session de l'opérateur.");
  }
  if ((accountBody.unreadCount ?? 0) < 1) {
    fail("Le compteur de non-lus du visiteur est à zéro alors que le staff vient de répondre.");
  }
  step(`l'historique du compte porte son fil, ${accountBody.unreadCount} réponse(s) non lue(s)`);

  // Lire, c'est remettre le compteur à zéro. Par la session, encore une fois
  // sans jeton : c'est ce que fait le panneau quand il s'ouvre.
  const markRead = await fetch(`${baseUrl}/api/support/conversations/${accountThreadId}/read`, {
    method: "POST",
    headers: { Cookie: operatorCookie, "X-CSRF-Token": operatorBody.csrfToken },
  });
  if (markRead.status !== 204) fail(`Accusé de lecture par la session : ${await readError(markRead)}`);
  const afterRead = await fetch(`${baseUrl}/api/support/conversations/${accountThreadId}`, {
    headers: { Cookie: operatorCookie },
  });
  const afterBody = await afterRead.json() as { unreadCount?: number };
  if ((afterBody.unreadCount ?? -1) !== 0) {
    fail(`Le compteur reste à ${afterBody.unreadCount} après lecture, zéro attendu.`);
  }

  // Le repère du rail du backoffice : combien de personnes attendent.
  const waiting = await fetch(`${baseUrl}/api/pro/staff/support/conversations?status=open&limit=1`, {
    headers: staffHeaders,
  });
  if (!waiting.ok) fail(`Compteur du rail : ${await readError(waiting)}`);
  const waitingBody = await waiting.json() as { openUnread?: number };
  if ((waitingBody.openUnread ?? 0) < 1) {
    fail("Le compteur du rail est à zéro alors qu'un fil attend une réponse.");
  }
  step(`le rail du backoffice compte ${waitingBody.openUnread} demande(s) en attente`);
} finally {
  /* ----------------- 9. les fils créés sont effacés, toujours ----------- */

  for (const id of created) {
    const erased = await fetch(`${baseUrl}/api/pro/staff/support/conversations/${id}`, {
      method: "DELETE",
      headers: staffHeaders,
    });
    if (erased.status !== 204) {
      // Signalé, jamais avalé : un fil de recette laissé dans la file
      // d'attente du guichet est un faux visiteur que quelqu'un lira.
      console.error(`  ATTENTION : le fil ${id} n'a pas pu être effacé (HTTP ${erased.status}).`);
    } else {
      step(`fil ${id} effacé`);
    }
  }
}

console.log("support-desk e2e: OK");
