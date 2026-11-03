import type { BotDto } from "./bots";

/**
 * Ce qu'un bot peut réellement appeler : et ce qu'il a réellement appelé.
 *
 * Les deux moitiés n'ont PAS la même portée et l'écran doit le dire :
 * `scope: "profile"` signifie que `toolsets`/`skills` et les serveurs MCP
 * relus concernent le profil nommé de ce bot ; `scope: "runtime"` conserve
 * l'inventaire commun du runtime historique. `usage` est toujours propre à
 * ce bot. Les présenter sans leur portée serait faux.
 */
export type BotCapabilitiesDto = {
  botId: string;
  /** `null` = ce bot parle à la racine du runtime (profil Hermes optionnel). */
  hermesProfile: string | null;
  /** `profile` only when the host exposes per-profile capabilities. */
  scope: "profile" | "runtime";
  /** The current operator may relay profile capability writes. */
  writable: boolean;
  /** The host can create a named profile for this bot. */
  profileManagement: boolean;
  runtimeName: string | null;
  /** `null` = ce build n'expose pas l'endpoint. Jamais « aucun ». */
  toolsets: BotToolsetDto[] | null;
  skills: BotSkillDto[] | null;
  /** Profile-scoped MCP flags and safe inventory details, or `null` outside that scope. */
  mcpServers: BotMcpServerDto[] | null;
  usage: BotToolUsageDto[];
  /**
   * Fenêtre de `usage`, en jours. `run_events` est un tampon de livraison SSE
   * purgé au-delà (0012) : au-delà de cette fenêtre, « jamais appelé » et
   * « appelé puis oublié » ne se distinguent plus.
   */
  usageWindowDays: number;
  /**
   * Pourquoi l'inventaire manque, quand il manque. Distingue les deux `null`
   * que `toolsets` peut porter : endpoint absent de ce build (`null` ici
   * aussi) et runtime qu'on n'a pas su lire (renseigné). Sans ce champ, un
   * Hermes éteint se lirait « ce build n'a pas de skills ».
   *
   * L'usage, lui, sort de notre base : il reste servi même runtime éteint :
   * ce qu'un 502 sec aurait emporté avec lui.
   */
  inventoryError: { code: string; message: string } | null;
};

export type BotToolsetDto = {
  name: string;
  label: string;
  description: string | null;
  /** Le modèle peut l'appeler. */
  enabled: boolean;
  /** Il aboutira. `enabled && !configured` = un échec qui attend son heure. */
  configured: boolean;
  tools: string[];
  /**
   * Les outils du toolset sont appelables sur l'hôte, d'après le registre
   * Hermes (`check_fn`), pas d'après `/v1/toolsets`. `null` : l'hôte ne le
   * dit pas (edge-setup plus ancien, lecture échouée, toolset non mesuré).
   */
  available: boolean | null;
  /** Code fermé, seulement quand `available` est `false` et que l'hôte le donne. */
  unavailableReason: "credentials_missing" | "check_failed" | null;
};

export type BotSkillDto = {
  name: string;
  description: string | null;
  category: string | null;
  /** Relu sur le profil (`disabled_skills`) ; `true` hors portée profil. */
  enabled: boolean;
  /** L'opérateur courant peut basculer cette skill sur le profil du bot. */
  writable: boolean;
};

export type BotProfileCredentialDto = {
  provider: string;
  profile: string;
  verification: "confirmed" | "denied" | "unverified";
  detail: string | null;
};

export type BotMcpServerDto = {
  name: string;
  enabled: boolean;
  transport: "http" | "stdio" | "unknown" | null;
  tools: string[] | null;
  unreachable: boolean | null;
};

/** Ce qu'openedbot tient en base et recrée sur un nouveau profil. */
export type BotProfileCarried = "identity" | "model" | "persona" | "conversations";

/** Ce qui ne vivait que dans le profil de l'ancien hôte. */
export type BotProfileLost = "memory" | "credentials" | "capabilities" | "sessions";

/** `missing` : le bot nomme un profil que le runtime actuel n'a pas (runtime remplacé). */
type BotProfileState = "present" | "missing" | "none" | "unknown";

export type BotProfileStatusDto = {
  profile: string | null;
  state: BotProfileState;
  /** L'hôte sait créer un profil : le transfert et la réinitialisation sont possibles. */
  canRepair: boolean;
  /**
   * Neither the bot (for a transfer) nor the runtime names a model: the repair
   * needs one chosen by the operator (`BotProfileRepairInput`), otherwise it is
   * refused with `RUNTIME_MODEL_REQUIRED` instead of creating a profile that no
   * run could use. Absent from an API older than the field: read it as false.
   */
  needsModel?: { transfer: boolean; reset: boolean };
  carried: BotProfileCarried[];
  lost: BotProfileLost[];
};

/** Body of `POST /api/bots/:botId/profile/{transfer,reset}`; the model is kept on the bot. */
export type BotProfileRepairInput = {
  model?: string;
  provider?: string;
};

export type BotProfileRepairDto = {
  bot: BotDto;
  mode: "transfer" | "reset";
  profile: string;
  /** Modèle posé sur le profil recréé ; `null` quand le runtime n'en impose aucun. */
  model: string | null;
  carried: BotProfileCarried[];
  lost: BotProfileLost[];
};

export type BotCapabilityMutationDto = {
  name: string;
  profile: string;
  platform?: string;
  enabled: boolean;
  requested: boolean;
  applied: boolean;
};

export type BotToolUsageDto = {
  tool: string;
  calls: number;
  failures: number;
  lastUsedAt: string;
};
