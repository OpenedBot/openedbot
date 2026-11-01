import { describe, expect, test } from "bun:test";
import { TRANSACTIONAL_EMAIL_KINDS, TRANSACTIONAL_EMAIL_LOCALES } from "@openedbot/contracts-api";
import { TRANSACTIONAL_EMAIL_SAMPLE_DATA } from "../src/domain/email/samples";
import { OPENEDBOT_SUPPORT_DISCORD_URL, renderTransactionalEmail } from "../src/domain/email/templates";

/**
 * Un genre déclaré sans gabarit ne part pas en message vide : il part en échec
 * de rendu chez le worker, pour chaque destinataire, jusqu'à épuisement des
 * reprises. Cette boucle est donc le garde-fou de la liste elle-même.
 */
describe("gabarits transactionnels", () => {
  test("chaque genre rend un sujet, un texte et un HTML dans les deux langues", () => {
    for (const kind of TRANSACTIONAL_EMAIL_KINDS) {
      for (const locale of TRANSACTIONAL_EMAIL_LOCALES) {
        const rendered = renderTransactionalEmail({
          kind,
          locale,
          data: TRANSACTIONAL_EMAIL_SAMPLE_DATA[kind],
        });
        expect(rendered.subject.length).toBeGreaterThan(0);
        expect(rendered.text.length).toBeGreaterThan(0);
        expect(rendered.html).toStartWith("<!DOCTYPE html>");
      }
    }
  });
});

describe("code de connexion staff", () => {
  test("porte le code et la durée, dans les deux langues", () => {
    const data = TRANSACTIONAL_EMAIL_SAMPLE_DATA.staff_login_code;
    for (const locale of TRANSACTIONAL_EMAIL_LOCALES) {
      const rendered = renderTransactionalEmail({ kind: "staff_login_code", locale, data });
      expect(rendered.text).toContain("482913");
      expect(rendered.text).toContain("10");
    }
  });
});

describe("mot de passe temporaire reposé par l’équipe", () => {
  const data = {
    email: "personne@example.test",
    temporaryPassword: "Rkvt-4bnq-8xmd-3phj",
    webAppUrl: "https://openedbot.app",
  };

  test("porte le mot de passe, l’adresse et le lien de connexion", () => {
    for (const locale of TRANSACTIONAL_EMAIL_LOCALES) {
      const rendered = renderTransactionalEmail({ kind: "staff_password_reset", locale, data });
      // Le mot de passe est la seule chose que ce message a à dire : sans lui,
      // la personne reste dehors et rien ne permet de le relire ailleurs.
      expect(rendered.text).toContain(data.temporaryPassword);
      expect(rendered.html).toContain(data.temporaryPassword);
      expect(rendered.text).toContain(data.email);
      expect(rendered.html).toContain("https://openedbot.app/login");
    }
  });

  test("dit que l’ancien mot de passe est mort et que les sessions sont fermées", () => {
    const fr = renderTransactionalEmail({ kind: "staff_password_reset", locale: "fr", data });
    const en = renderTransactionalEmail({ kind: "staff_password_reset", locale: "en", data });
    // Quelqu'un déconnecté au milieu de son travail doit lire ici POURQUOI,
    // sinon il cherche une panne là où il y a eu une décision.
    expect(fr.text).toContain("L’ancien ne fonctionne plus");
    expect(fr.text).toContain("Toute session encore ouverte a été fermée");
    expect(en.text).toContain("The previous one no longer works");
    expect(en.text).toContain("Any session still open has been closed");
  });

  test("n’est pas le message de création : ni le même sujet, ni la même promesse", () => {
    const reset = renderTransactionalEmail({ kind: "staff_password_reset", locale: "fr", data });
    const created = renderTransactionalEmail({
      kind: "staff_account_created",
      locale: "fr",
      data: TRANSACTIONAL_EMAIL_SAMPLE_DATA.staff_account_created,
    });
    expect(reset.subject).not.toBe(created.subject);
    // « Votre compte a été créé » sur un compte qui existe depuis six mois
    // ferait douter du message entier.
    expect(reset.text).not.toContain("Votre compte a été créé");
  });

  test("sans origine publique, pas de bouton inventé", () => {
    const rendered = renderTransactionalEmail({
      kind: "staff_password_reset",
      locale: "fr",
      data: { email: data.email, temporaryPassword: data.temporaryPassword },
    });
    expect(rendered.text).toContain(data.temporaryPassword);
    expect(rendered.html).not.toContain("/login");
  });
});

describe("ouverture d’accès", () => {
  const data = {
    email: "personne@example.test",
    temporaryPassword: "Mjtd-6kpr-9wxb-4nqh",
    webAppUrl: "https://openedbot.app",
  };

  test("porte le mot de passe temporaire quand la décision en a posé un", () => {
    for (const locale of TRANSACTIONAL_EMAIL_LOCALES) {
      const rendered = renderTransactionalEmail({ kind: "waitlist_access_granted", locale, data });
      expect(rendered.text).toContain(data.temporaryPassword);
      expect(rendered.text).toContain(data.email);
    }
  });

  test("sans mot de passe, garde sa forme d’origine et sa note d’origine", () => {
    const rendered = renderTransactionalEmail({
      kind: "waitlist_access_granted",
      locale: "fr",
      data: { webAppUrl: data.webAppUrl },
    });
    expect(rendered.text).toContain("Votre accès est ouvert");
    // Promettre « aucun compte n'est créé » sous un mot de passe qui vient
    // d'être posé serait faux : la note change avec le contenu.
    expect(rendered.text).toContain("aucun compte n’est créé");
    expect(rendered.text).not.toContain("Mot de passe temporaire");
  });

  test("avec mot de passe, dit qu’il est temporaire et que les sessions sont fermées", () => {
    const fr = renderTransactionalEmail({ kind: "waitlist_access_granted", locale: "fr", data });
    const en = renderTransactionalEmail({ kind: "waitlist_access_granted", locale: "en", data });
    expect(fr.text).toContain("Toute session encore ouverte a été fermée");
    expect(fr.text).not.toContain("aucun compte n’est créé");
    expect(en.text).toContain("Any session still open has been closed");
  });

  // Le Discord est le seul canal de support : l'e-mail d'ouverture d'accès le
  // porte, avec ou sans mot de passe temporaire, en HTML comme en texte brut,
  // dans les deux langues.
  test("porte le lien du Discord de support, HTML et texte, dans les deux langues", () => {
    for (const locale of TRANSACTIONAL_EMAIL_LOCALES) {
      const rendered = renderTransactionalEmail({ kind: "waitlist_access_granted", locale, data });
      expect(rendered.html).toContain(OPENEDBOT_SUPPORT_DISCORD_URL);
      expect(rendered.text).toContain(OPENEDBOT_SUPPORT_DISCORD_URL);
    }
  });

  test("porte le lien du Discord même sans mot de passe temporaire", () => {
    const rendered = renderTransactionalEmail({
      kind: "waitlist_access_granted",
      locale: "fr",
      data: { webAppUrl: data.webAppUrl },
    });
    expect(rendered.html).toContain(OPENEDBOT_SUPPORT_DISCORD_URL);
    expect(rendered.text).toContain(OPENEDBOT_SUPPORT_DISCORD_URL);
  });
});

describe("connector à mettre à jour", () => {
  const data = {
    runtimeName: "VPS production",
    installedVersion: "v0.5.3",
    targetVersion: "v0.5.7",
    upgradeCommand: "sudo edge-setup upgrade --yes",
    settingsUrl: "https://openedbot.app/o/atelier/settings/runtime",
  };

  test("porte le runtime, les deux versions, la commande, l’impossibilité d’agir et le lien", () => {
    for (const locale of TRANSACTIONAL_EMAIL_LOCALES) {
      const rendered = renderTransactionalEmail({ kind: "runtime_connector_outdated", locale, data });
      expect(rendered.subject).toContain(data.runtimeName);
      for (const value of [data.installedVersion, data.targetVersion, data.upgradeCommand]) {
        expect(rendered.text).toContain(value);
      }
      expect(rendered.text).toContain(locale === "fr" ? "openedbot ne peut pas mettre à jour" : "openedbot cannot update");
      expect(rendered.html).toContain(`href="${data.settingsUrl}"`);
    }
  });
});
