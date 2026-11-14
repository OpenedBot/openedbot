import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../src/lib/i18n";
import { ApiError } from "../../src/lib/api";
import { AppErrorBoundary, AppErrorScreen } from "../../src/components/app-error-boundary";
import { FailureState, classifyFailure } from "../../src/components/failure-state";

// These cases check FRENCH copy: the language is set explicitly,
// the product default now being English (`DEFAULT_LOCALE`).
beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
});

afterEach(cleanup);

function show(node: React.ReactNode) {
  render(<I18nProvider>{node}</I18nProvider>);
}

describe("classifyFailure", () => {
  test("porte le code, le statut et la référence : ce qui distingue les pannes", () => {
    const detail = classifyFailure(new ApiError(502, "Hermes a refusé le token.", "HERMES_TOKEN_REJECTED", "a1b2c3"));
    expect(detail.message).toBe("Hermes a refusé le token.");
    expect(detail.requestId).toBe("a1b2c3");
    expect(detail.facts).toEqual([
      ["code", "HERMES_TOKEN_REJECTED"],
      ["HTTP", "502"],
      ["ref", "a1b2c3"],
    ]);
  });

  test("une API injoignable n'invente ni statut ni référence", () => {
    // The request never left: « HTTP 0 » would name a state that
    // does not exist, and there is no log line to cite.
    const detail = classifyFailure(new ApiError(0, "Le cloud est injoignable.", "API_UNAVAILABLE"));
    expect(detail.kind).toBe("offline");
    expect(detail.facts).toEqual([]);
    expect(detail.requestId).toBeNull();
    expect(detail.message).toBe("Le cloud est injoignable.");
  });

  test("une exception de programmation ne devient pas la phrase de l'écran", () => {
    // « crypto.randomUUID is not a function » describes our code, not the
    // operator's gesture: the screen falls back to its own sentence.
    const detail = classifyFailure(new TypeError("crypto.randomUUID is not a function"));
    expect(detail.kind).toBe("crash");
    expect(detail.message).toBe("");
    expect(detail.facts).toEqual([]);
  });

  test("le statut décide de la nature, donc du geste proposé", () => {
    const kindOf = (status: number) => classifyFailure(new ApiError(status, "…", "X", "ref")).kind;
    expect(kindOf(401)).toBe("denied");
    expect(kindOf(403)).toBe("denied");
    expect(kindOf(404)).toBe("missing");
    expect(kindOf(409)).toBe("refused");
    expect(kindOf(503)).toBe("upstream");
    expect(kindOf(500)).toBe("fault");
  });
});

describe("FailureState", () => {
  test("montre la phrase de l'API, son code et sa référence", () => {
    show(<FailureState error={new ApiError(500, "Erreur interne.", "INTERNAL_ERROR", "ref-42")} fallback="repli" />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Erreur interne.")).toBeTruthy();
    expect(screen.getByText("INTERNAL_ERROR")).toBeTruthy();
    expect(screen.getByText("ref-42")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copier la référence/i })).toBeTruthy();
  });

  test("un 500 dit que l'API a échoué, pas « quelque chose »", () => {
    show(<FailureState error={new ApiError(500, "Erreur interne.", "INTERNAL_ERROR", "ref-42")} fallback="repli" />);
    expect(screen.getByText("L’API a échoué")).toBeTruthy();
    // The path says how far it got; its sentence is what a
    // screen reader hears, instead of the segments.
    expect(screen.getByRole("img", { name: /L’API a été atteinte, et c’est elle qui a échoué\./ })).toBeTruthy();
    // The reference is promoted: it is not repeated in the technical line.
    expect(screen.getAllByText("ref-42")).toHaveLength(1);
    expect(screen.queryByText("ref")).toBeNull();
  });

  test("un refus d'accès ne se peint pas comme une panne et n'offre rien à copier", () => {
    show(<FailureState error={new ApiError(403, "Réservé aux propriétaires.", "FORBIDDEN", "ref-7")} fallback="repli" />);
    expect(screen.getByText("Accès refusé")).toBeTruthy();
    expect(screen.getByText("Réservé aux propriétaires.")).toBeTruthy();
    // Nothing to forward: the API answered what it was supposed to answer. The
    // reference stays in the technical line, with no button.
    expect(screen.queryByRole("button", { name: /Copier la référence/i })).toBeNull();
    expect(screen.getByText("ref")).toBeTruthy();
  });

  test("une API injoignable ne dessine aucun trajet franchi", () => {
    show(<FailureState error={new ApiError(0, "L’API cloud ne répond pas encore.", "API_UNAVAILABLE")} fallback="repli" />);
    expect(screen.getByText("Le cloud est injoignable")).toBeTruthy();
    expect(screen.getByRole("img", { name: /La requête n’est pas partie/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Copier la référence/i })).toBeNull();
  });

  test("retombe sur la phrase de l'écran quand l'erreur n'en porte pas", () => {
    show(<FailureState error={new Error("boom")} fallback="L’inventaire n’a pas pu être chargé." />);
    expect(screen.getByText("L’inventaire n’a pas pu être chargé.")).toBeTruthy();
    // Nothing to forward: no button that would copy emptiness.
    expect(screen.queryByRole("button", { name: /Copier la référence/i })).toBeNull();
    // Nothing was requested: a path would draw a trip that did not happen.
    expect(screen.queryByRole("img")).toBeNull();
  });
});

describe("AppErrorBoundary", () => {
  test("remplace la page blanche par un écran qui offre un geste", () => {
    const Boom = () => {
      throw new Error("rendu interrompu");
    };
    // React writes the exception to the console; the test does not have to relay it.
    const consoleError = console.error;
    console.error = () => undefined;
    try {
      show(<AppErrorBoundary><Boom /></AppErrorBoundary>);
    } finally {
      console.error = consoleError;
    }
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Cet écran s’est arrêté")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Réessayer" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Quitter" })).toBeTruthy();
    expect(screen.queryByText("Recharger")).toBeNull();
    // The stack stays in the console: it names our files, not the gesture.
    expect(screen.queryByText(/rendu interrompu/)).toBeNull();
  });

  test("l'écran du routeur affiche le détail d'un refus de l'API", () => {
    show(<AppErrorScreen error={new ApiError(403, "Accès refusé.", "FORBIDDEN", "ref-7")} />);
    expect(screen.getByText("Accès refusé")).toBeTruthy();
    expect(screen.getByText("Accès refusé.")).toBeTruthy();
    expect(screen.getByText("FORBIDDEN")).toBeTruthy();
    expect(screen.getByText("403")).toBeTruthy();
    expect(screen.getByText("ref-7")).toBeTruthy();
  });
});
