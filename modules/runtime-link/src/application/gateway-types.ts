import type { LinkConnection, LinkIdentity, LinkPeer } from "./broker";

/** Les types d'une session du lien connecteur, partagés par la montée (`gateway.ts`) et l'enrôlement. */

export type LinkEnrollment = {
  id: string;
  organizationId: string;
  runtimeName: string;
  dedicated?: boolean;
  /** The engine its `hello` declared: a machine ticket names its runtime after it. */
  engine?: string | null;
};

export type LinkCredential =
  | {
      kind: "link";
      identity: LinkIdentity;
      /** `runtimes.link_device_pubkey` : présente, la session doit prouver la possession de la clé. */
      registeredDeviceKey?: string | null;
    }
  | { kind: "enrollment"; enrollment: LinkEnrollment };

/** Le défi de possession en cours : le nonce, la clé attendue, et si elle est à inscrire. */
export type LinkPopState = {
  nonce: string;
  devicePublicKey: string;
  firstKey: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

export type LinkSocketData = {
  credential: LinkCredential;
  /** L'adresse vue à la montée (celle du rate limit) et le `User-Agent` : journal du lien, règle hijack. */
  peer: LinkPeer;
  state: "awaiting_hello" | "awaiting_proof" | "provisional" | "binding" | "bound";
  connection: LinkConnection | null;
  helloTimer: ReturnType<typeof setTimeout> | null;
  pop?: LinkPopState | null;
  /** `hello.hermesVersion`, écrit avec l'agent au `bind` (0162). */
  hermesVersion?: string | null;
  engine?: string | null;
  engineVersion?: string | null;
  /** Hors production : `ws://127.0.0.1:<port>` du tunnel composé (en-tête `Host`), voir devTunnelWsUrl. */
  devTunnelWsUrl?: string | null;
};

/** Ce qu'un enrôlement réussi produit : l'identité liée ET le jeton, remis une seule fois à l'hôte. */
export type IssuedLink = { identity: LinkIdentity; linkToken: string };

export type LinkEnroller = (
  connection: LinkConnection,
  enrollment: LinkEnrollment,
  signal: AbortSignal,
) => Promise<IssuedLink>;
