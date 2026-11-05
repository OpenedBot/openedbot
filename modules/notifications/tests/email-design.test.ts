import { describe, expect, test } from "bun:test";
import { EMAIL_BRAND_MARK_URL, EMAIL_COLORS, renderEmailHtml, renderEmailText, safeUrl, type EmailDocument } from "../src/domain/email/design";
import { renderTransactionalEmail } from "../src/domain/email/templates";

const document: EmailDocument = {
  locale: "fr",
  subject: "Objet du message",
  preheader: "La ligne de prévisualisation",
  blocks: [
    { kind: "heading", text: "Un titre" },
    { kind: "paragraph", text: "Un paragraphe avec un <script> et une \"citation\"." },
    { kind: "rows", rows: [["Clé", "Valeur"], ["Autre", "Suivante"]] },
    { kind: "divider" },
    { kind: "button", label: "Ouvrir", url: "https://console.openedbot.app/settings/models" },
    { kind: "note", text: "Une note grise." },
  ],
  footerReason: "Vous recevez ce message parce que.",
  footerLinks: [["Mentions légales", "https://console.openedbot.app/legal/mentions"]],
};

/** Un attribut `style="…"` qui contiendrait un guillemet double se refermerait au milieu. */
function brokenStyleAttributes(html: string): string[] {
  return [...html.matchAll(/style="([^"]*)/g)]
    .map((match) => match[1] ?? "")
    .filter((value) => value.includes('"'));
}

describe("coque HTML des e-mails", () => {
  const html = renderEmailHtml(document);

  test("est un document complet, et lisible en source", () => {
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('<html lang="fr"');
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    // Indenté : un e-mail se relit dans le « HTML Source » d'un client de test.
    expect(html.split("\n").length).toBeGreaterThan(30);
    expect(html).toContain('\n  <table role="presentation"');
  });

  test("est une carte blanche sur le fond de BoardUI, et interdit au client de l'inverser", () => {
    expect(html).toContain(`background-color:${EMAIL_COLORS.page}`);
    expect(html).toContain(`background-color:${EMAIL_COLORS.card};border:1px solid ${EMAIL_COLORS.cardEdge};border-radius:20px`);
    expect(html).toContain(`color:${EMAIL_COLORS.ink}`);
    expect(html).toContain('name="color-scheme" content="light"');
    expect(html).toContain('name="supported-color-schemes" content="light"');
    expect(html).toContain("color-scheme:light");
    // Aucun mode sombre : ni requête média, ni couleur de repli.
    expect(html).not.toContain("prefers-color-scheme");
    expect(html.toLowerCase()).not.toContain("#000000");
  });

  test("porte le logo du site, en colonne de 520, et pose les détails dans un panneau", () => {
    // Le logo en PNG (jamais WebP, qu'Outlook ne lit pas), nommé dans `alt`
    // pour un client qui bloque les images.
    expect(html).toContain(`<img src="${EMAIL_BRAND_MARK_URL}" width="40" height="40" alt="openedbot"`);
    expect(EMAIL_BRAND_MARK_URL.endsWith(".png")).toBe(true);
    expect(html).toContain("max-width:520px");
    expect(html).toContain("font-size:15px;line-height:1.6");
    // Le bouton principal de la console : dégradé, avec une teinte pleine en repli.
    expect(html).toContain(`background-color:${EMAIL_COLORS.action};background-image:linear-gradient(`);
    expect(html).toContain("border-radius:10px");
    expect(html).toContain(`background-color:${EMAIL_COLORS.panel};border-radius:12px`);
    expect(html).toContain(`background-color:${EMAIL_COLORS.line}`);
    // La signature parle la langue du message.
    expect(html).toContain("openedbot, la console dans votre navigateur, le bot sur votre serveur.");
  });

  test("rend un code en grand dans le panneau, et en clair dans le texte", () => {
    const withCode: EmailDocument = { ...document, blocks: [{ kind: "code", label: "Code", code: "482913" }] };
    expect(renderEmailHtml(withCode)).toContain('class="openedbot-code" aria-label="Code">482913</td>');
    expect(renderEmailText(withCode)).toContain("Code : 482913");
  });

  test("est fait de tableaux de présentation, jamais de flex ni de bgcolor", () => {
    expect(html).toContain('role="presentation"');
    expect(html).not.toContain("display:flex");
    expect(html).not.toContain("display:grid");
    // `bgcolor` gagnerait sur la requête média : la carte resterait blanche en sombre.
    expect(html).not.toContain("bgcolor=");
  });

  test("aucun attribut style n'est cassé par un guillemet", () => {
    expect(brokenStyleAttributes(html)).toEqual([]);
  });

  test("le bouton a ses coins VML pour Outlook et son lien pour les autres", () => {
    expect(html).toContain("<!--[if mso]><v:roundrect");
    expect(html).toContain('arcsize="23%"');
    expect(html).toContain("<!--[if !mso]><!-->");
  });

  test("la ligne de prévisualisation est cachée et rembourrée", () => {
    expect(html).toContain("La ligne de prévisualisation");
    expect(html).toContain("mso-hide:all");
    expect(html).toContain("&#65279;");
  });

  test("échappe ce que le message contient", () => {
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;citation&quot;");
  });
});

describe("safeUrl", () => {
  test("laisse passer http et https, refuse le reste", () => {
    expect(safeUrl("https://console.openedbot.app/x")).toBe("https://console.openedbot.app/x");
    expect(safeUrl("http://127.0.0.1:1420/x")).toBe("http://127.0.0.1:1420/x");
    expect(safeUrl("javascript:alert(1)")).toBe("#");
    expect(safeUrl("data:text/html,<script>")).toBe("#");
    expect(safeUrl("pas une url")).toBe("#");
  });

  test("échappe ce qui sortirait de l'attribut href", () => {
    expect(safeUrl('https://example.test/?a=1&b="x"')).not.toContain('"');
  });
});

describe("texte brut", () => {
  test("dit le même message, sans balise", () => {
    const text = renderEmailText(document);
    expect(text).toContain("Un titre");
    expect(text).toContain("Clé : Valeur");
    expect(text).toContain("Ouvrir : https://console.openedbot.app/settings/models");
    expect(text).toContain("Mentions légales : https://console.openedbot.app/legal/mentions");
    // Le texte brut rend la copie telle qu'elle est écrite : ni balise ajoutée
    // par le rendu, ni entité d'échappement. Un `<script>` dans la copie reste
    // un `<script>`, il n'y a pas de moteur pour l'interpréter.
    expect(text).toContain("un <script> et une \"citation\"");
    expect(text).not.toMatch(/<\/?(?:p|td|tr|table|a|h1|div)\b/u);
    expect(text).not.toContain("&amp;");
    expect(text).not.toContain("&quot;");
  });
});

describe("gabarits transactionnels", () => {
  const kinds = ["account_purge_completed", "provider_quota_reached", "waitlist_confirmation"] as const;

  test("chaque genre rend un objet, un texte et un document HTML dans les deux langues", () => {
    for (const kind of kinds) {
      for (const locale of ["fr", "en"]) {
        const rendered = renderTransactionalEmail({
          kind,
          locale,
          data: {
            provider: "anthropic",
            occurredAt: "2026-09-08T14:32:00.000Z",
            fallback: "opencode-free / nemotron",
            settingsUrl: "https://console.openedbot.app/settings/models",
            purgedAt: "2026-09-08",
            webAppUrl: "https://console.openedbot.app",
          },
        });
        expect(rendered.subject.length).toBeGreaterThan(0);
        expect(rendered.text.length).toBeGreaterThan(0);
        expect(rendered.html.startsWith("<!DOCTYPE html>")).toBe(true);
        expect(brokenStyleAttributes(rendered.html)).toEqual([]);
      }
    }
  });

  // AUCUN genre ne porte de pied de page légal : les deux pages n'ont pas
  // encore de contenu, et lier une page vide vaut moins que ne pas la lier.
  // Le rendu, lui, sait toujours poser ces liens (`footerLinks`, `design.ts`,
  // couvert plus haut) : le jour où ces pages existent, il n'y a qu'à les
  // remettre dans les gabarits, et ce test le dira.
  test("aucun message n'est envoyé avec un lien légal", () => {
    for (const kind of kinds) {
      for (const locale of ["fr", "en"]) {
        const rendered = renderTransactionalEmail({
          kind,
          locale,
          data: { webAppUrl: "https://console.openedbot.app", settingsUrl: "https://console.openedbot.app/settings/models" },
        });
        expect(rendered.html).not.toContain("/legal/");
        expect(rendered.text).not.toContain("/legal/");
      }
    }
  });

  test("sans origine dans la charge utile, le pied de page n'invente aucun lien", () => {
    const rendered = renderTransactionalEmail({
      kind: "waitlist_confirmation",
      locale: "fr",
      data: {},
    });
    expect(rendered.html).not.toContain("/legal/");
    expect(rendered.text).not.toContain("http");
  });

  test("la confirmation de liste d'attente porte son bandeau en tête", () => {
    const rendered = renderTransactionalEmail({
      kind: "waitlist_confirmation",
      locale: "fr",
      data: { webAppUrl: "https://console.openedbot.app" },
    });
    expect(rendered.html).toContain('src="https://console.openedbot.app/email/waitlist-banner.jpg"');
    // Les attributs portent la taille AFFICHÉE, le style la rend responsive.
    expect(rendered.html).toContain('width="440" height="213"');
    expect(rendered.html).toContain("display:block;width:100%;max-width:440px;height:auto");
    // JPEG et non WebP : Outlook rend le HTML avec le moteur de Word, qui
    // afficherait un cadre vide.
    expect(rendered.html).not.toContain(".webp");
    // Décorative : rien à annoncer, et rien à afficher si l'image est bloquée.
    expect(rendered.html).toContain('alt=""');
    // La version texte porte le message, pas le dessin.
    expect(rendered.text).not.toContain("waitlist-banner");
    expect(rendered.text).toContain("Vous êtes sur la liste");
  });

  test("sans origine dans la charge utile, aucun bandeau n'est posé", () => {
    // Une URL relative ne s'affiche dans aucun client de messagerie : mieux
    // vaut pas d'image du tout qu'un cadre vide en tête du message.
    const rendered = renderTransactionalEmail({
      kind: "waitlist_confirmation",
      locale: "fr",
      data: {},
    });
    expect(rendered.html).not.toContain("waitlist-banner");
    // Seul le logo, à son URL fixe, reste en tête.
    expect(rendered.html.match(/<img /g)?.length).toBe(1);
  });

  test("la confirmation de liste d'attente ne pousse aucun bouton vers la console", () => {
    const rendered = renderTransactionalEmail({
      kind: "waitlist_confirmation",
      locale: "fr",
      data: { webAppUrl: "https://console.openedbot.app" },
    });
    expect(rendered.html).not.toContain("v:roundrect");
  });
});
