import {
  policyWithFunnelTag,
  tailnetDomainFromDevices,
  TailscaleApiError,
  TAILSCALE_OPENEDBOT_TAG,
  type TailscaleApiClient,
} from "@openedbot/platform-integrations/tailscale-api";

/**
 * Publier un gateway direct sur le tailnet du client, en une passe.
 *
 * Le pendant Tailscale de `provisionDirectExposure` : l'attribut `funnel` sur
 * le tag d'openedbot dans le fichier de politique, puis une clé d'appairage taguée
 * et préautorisée. La machine, elle, naît quand l'opérateur colle la commande
 * sur l'hôte : openedbot ne touche jamais le serveur.
 *
 * Deux différences assumées avec Cloudflare. Le hostname n'est pas créé mais
 * PRÉDIT (`<slug>.<domaine du tailnet>`), parce que MagicDNS le compose à
 * partir du nom de machine ; un tailnet encore vide ne permet pas de lire son
 * domaine et la passe s'arrête là. Et l'édition du fichier de politique n'est
 * pas compensée : elle est additive et partagée par toutes les publications du
 * tailnet, la retirer casserait les autres.
 *
 * Funnel n'a pas d'équivalent d'Access : aucune paire de service token n'est
 * produite ici, le bearer `API_SERVER_KEY` du gateway reste sa seule protection.
 */
export type TailscaleExposureProvisionInput = {
  /** Le nom de machine demandé ; premier label du nom MagicDNS. */
  slug: string;
  tag?: string;
  keyTtlSeconds?: number;
};

export type TailscaleExposureProvisionResult = {
  hostname: string;
  /** Rendu au client une fois, puis chiffré : c'est le secret de la commande. */
  authKey: string;
  authKeyId: string;
  tailnetDomain: string;
  /** Vrai quand cette passe a dû écrire le fichier de politique. */
  policyRevised: boolean;
};

/** Le port du gateway Hermes que Funnel publie en HTTPS. */
export const HERMES_FUNNEL_PORT = 8642;
/** La clé d'appairage vit un jour : le temps de coller la commande, pas plus. */
export const TAILSCALE_KEY_TTL_SECONDS = 86_400;

export async function provisionTailscaleExposure(
  client: TailscaleApiClient,
  input: TailscaleExposureProvisionInput,
): Promise<TailscaleExposureProvisionResult> {
  const tag = input.tag ?? TAILSCALE_OPENEDBOT_TAG;
  const devices = await client.listDevices();
  const tailnetDomain = tailnetDomainFromDevices(devices);
  if (!tailnetDomain) {
    throw new TailscaleApiError("TAILSCALE_TAILNET_UNKNOWN", null, "Aucune machine connectée : le domaine du tailnet ne peut pas être lu.");
  }
  const hostname = `${input.slug}.${tailnetDomain}`;
  // Un nom MagicDNS déjà pris appartient à une machine : ne jamais le reprendre.
  if (devices.some((device) => device.name.toLowerCase() === hostname)) {
    throw new TailscaleApiError("TAILSCALE_CONFLICT", null, "Ce nom de machine est déjà pris sur ce tailnet.");
  }

  const { policy, etag } = await client.readPolicy();
  const revised = policyWithFunnelTag(policy, tag);
  if (revised.changed) await client.writePolicy(revised.policy, etag);

  const key = await client.createAuthKey({
    tag,
    description: `openedbot Hermes ${hostname}`,
    expirySeconds: input.keyTtlSeconds ?? TAILSCALE_KEY_TTL_SECONDS,
  });

  return { hostname, authKey: key.key, authKeyId: key.id, tailnetDomain, policyRevised: revised.changed };
}

/** La commande unique à coller sur l'hôte : joindre le tailnet, puis publier le gateway. */
export function tailscaleInstallCommand(authKey: string, slug: string, tag: string = TAILSCALE_OPENEDBOT_TAG): string {
  return `sudo tailscale up --auth-key ${authKey} --hostname ${slug} --advertise-tags ${tag} && sudo tailscale funnel --bg ${HERMES_FUNNEL_PORT}`;
}

export type TailscaleExposureResources = {
  hostname: string;
  authKeyId: string | null;
};

/**
 * Retire ce qu'une publication a créé : la clé d'appairage, puis la machine
 * qui porte le hostname. Une ressource déjà absente n'est pas une erreur ;
 * tout autre échec ressort après avoir tenté les autres retraits.
 *
 * Le tag et son attribut `funnel` restent dans le fichier de politique : ils
 * servent aux autres publications du même tailnet.
 */
export async function deprovisionTailscaleExposure(
  client: TailscaleApiClient,
  resources: TailscaleExposureResources,
): Promise<void> {
  let failure: unknown = null;
  const attempt = async (step: () => Promise<void>): Promise<void> => {
    try { await step(); } catch (error) {
      if (error instanceof TailscaleApiError && error.code === "TAILSCALE_NOT_FOUND") return;
      failure ??= error;
    }
  };
  if (resources.authKeyId) await attempt(() => client.deleteAuthKey(resources.authKeyId!));
  await attempt(async () => {
    const device = (await client.listDevices()).find((candidate) => candidate.name.toLowerCase() === resources.hostname.toLowerCase());
    if (device) await client.deleteDevice(device.id);
  });
  if (failure) throw failure;
}
