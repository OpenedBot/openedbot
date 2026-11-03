import { describe, expect, test } from "bun:test";
import {
  effectiveAdminMode,
  readOrganizationRuntimeModeIn,
  runtimeModeAllowed,
} from "@openedbot/runtimes/application/runtime-mode";
import type { ApiConfig } from "../src/infrastructure/config";
import type { TransactionDb } from "@openedbot/platform-db";
import type { RuntimeMode } from "@openedbot/contracts-api";

function config(
  environment: ApiConfig["environment"],
  runtimeMode: RuntimeMode,
  runtimeAdminChannels: ApiConfig["runtimeAdminChannels"],
): ApiConfig {
  return { environment, runtimeMode, runtimeAdminChannels } as unknown as ApiConfig;
}

const NO_CHANNEL = { local: false };
const BOTH_CHANNELS = { local: true };

/** Un `tx` qui répond une seule ligne, quelle que soit la requête. */
function transaction(runtimeMode: string | null | undefined): TransactionDb {
  const rows = runtimeMode === undefined ? [] : [{ runtimeMode }];
  return (() => Promise.resolve(rows)) as unknown as TransactionDb;
}

describe("mode runtime d’une organisation", () => {
  test("le seul mode runtime accepté est external", () => {
    expect(runtimeModeAllowed("external", config("production", "external", NO_CHANNEL))).toBe(true);
  });

  test("une organisation sans choix suit le défaut du déploiement", async () => {
    const deployment = config("development", "external", BOTH_CHANNELS);
    await expect(readOrganizationRuntimeModeIn(transaction(null), deployment, "org-1"))
      .resolves.toBe("external");
    await expect(readOrganizationRuntimeModeIn(transaction(undefined), deployment, "org-1"))
      .resolves.toBe("external");
  });

  test("le choix enregistré l’emporte sur la variable d’environnement", async () => {
    const deployment = config("development", "external", BOTH_CHANNELS);
    await expect(readOrganizationRuntimeModeIn(transaction("external"), deployment, "org-1"))
      .resolves.toBe("external");
  });

  test("une valeur inconnue en base retombe sur le défaut", async () => {
    const deployment = config("development", "external", BOTH_CHANNELS);
    await expect(readOrganizationRuntimeModeIn(transaction("legacy"), deployment, "org-1"))
      .resolves.toBe("external");
  });
});

describe("canal d’administration dérivé du mode", () => {
  test("un déploiement sans administration le reste, quel que soit le mode", () => {
    expect(effectiveAdminMode(config("production", "external", NO_CHANNEL), "external")).toBe("disabled");
  });

  // Le point du découplage : le même processus sert les deux modes, donc
  // basculer sur un runtime externe ouvre le canal SSH sans redémarrage.
  test("le canal suit le mode de l’organisation, pas celui du démarrage", () => {
    const deployment = config("development", "external", BOTH_CHANNELS);
    expect(effectiveAdminMode(deployment, "external")).toBe("disabled");
  });

  // Un hôte qui ne sait pas servir un canal ne doit pas le promettre :
  // l'interface afficherait des actions qui répondent 404.
  test("un mode dont le canal n’existe pas sur cet hôte retombe fermé", () => {
    expect(effectiveAdminMode(config("development", "external", { local: true }), "external"))
      .toBe("disabled");
  });
});
