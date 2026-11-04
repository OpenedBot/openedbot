/** English strings, one file per domain: `messages.en.ts` assembles them. */

export const relativeTime = {
  never: "never",
  seconds: "{count} s ago",
  minutes: "{count} min ago",
  hours: "{count} h ago",
  days: "{count} d ago",
} as const;

export const units = {
  byte: "B",
  kibibyte: "KiB",
  mebibyte: "MiB",
  gibibyte: "GiB",
  tebibyte: "TiB",
} as const;

export const common = {
  never: "Never",
  loading: "Loading…",
  cancel: "Cancel",
  confirm: "Confirm",
  close: "Close",
  retry: "Retry",
  workspaceAccessRevoked: "You no longer have access to this workspace.",
} as const;

export const errorState = {
  unexpected: "Reload the page to continue.",
  copyReference: "Copy the reference",
  referenceCopied: "Reference copied",
  retry: "Retry",
  quit: "Quit",
  hopBrowser: "browser",
  hopApi: "API",
  hopRuntime: "runtime",
  transmit: "There is nothing to fix on your side. This reference points at the exact log line: pass it on.",
  offlineTitle: "The cloud is unreachable",
  offlinePath: "The request never left: the browser did not reach the API.",
  deniedTitle: "Access refused",
  deniedPath: "The API answered, and it refuses this access.",
  missingTitle: "This item no longer exists",
  missingPath: "The API answered, and it cannot find what was asked for.",
  refusedTitle: "Request refused",
  refusedPath: "The API answered, and it refuses the request as it stands.",
  upstreamTitle: "The runtime did not answer",
  upstreamPath: "The API was reached; the request stops beyond it, on the way to the runtime.",
  faultTitle: "The API failed",
  faultPath: "The API was reached, and the API is what failed.",
  runtimeAnsweredPath: "The runtime was reached, and the runtime is what refuses.",
  /* Facts a screen adds to the card footer when it knows which runtime it is talking about. */
  factRuntime: "runtime",
  factState: "state",
  factChecked: "checked",
  crashTitle: "This screen stopped",
} as const;

export const notFound = {
  title: "This page does not exist",
  description: "The requested address matches no screen. A link may have changed since, or the item it pointed to was deleted.",
  home: "Back to home",
  back: "Go back",
} as const;

export const eventParts = {
  toolFallback: "tool",
  toolsCount: "{count} tools",
} as const;

export const toolLabels = {
  terminal: "Runs a command",
  shell: "Runs a command",
  skill_view: "Reads a skill",
  delegate_task: "Delegates a task",
  async_delegation: "Delegates in the background",
  subagent: "Starts a subagent",
  search: "Searches the web",
  web_search: "Searches the web",
  http: "Fetches a URL",
  read_file: "Reads a file",
  write_file: "Writes a file",
  cat: "Reads a file",
  search_files: "Searches files",
  skills_list: "Lists skills",
  execute_code: "Runs code",
  web_extract: "Reads a web page",
} as const;

export const apiClient = {
  cloudUnavailable: "The cloud API is not responding yet.",
  httpUnauthorized: "Session expired: sign in again (HTTP {status}).",
  httpForbidden: "The API refused this action (HTTP {status}).",
  httpNotFound: "Not found on the API (HTTP {status}).",
  httpTimeout: "The API did not answer in time (HTTP {status}).",
  httpRateLimited: "Too many requests, try again in a moment (HTTP {status}).",
  httpGateway: "The API is unreachable or restarting (HTTP {status}).",
  httpServerError: "The API hit an error without explaining it (HTTP {status}). Retry; if it persists, check its log.",
  httpRefused: "Request refused by the API (HTTP {status}).",
  /** Client deadline exceeded, no HTTP status: a read is safe to retry. */
  readTimeout: "The API did not answer in time. Try again in a moment.",
  /** A write without an answer may have gone through: do not blindly redo it. */
  writeTimeout: "The API did not answer in time: the action may have gone through. Check before trying again.",
  /** A success whose body is not JSON (proxy page, truncated answer). */
  invalidResponse: "Unreadable answer from the API (HTTP {status}): nothing was confirmed.",
} as const;

export const face = {
  shapes: {
    cercle: "Circle",
    galet: "Pebble",
    squircle: "Squircle",
    capsule: "Capsule",
    triangle: "Triangle",
    hexagone: "Hexagon",
    nuage: "Cloud",
    goutte: "Droplet",
  },
  colors: {
    encre: "Ink",
    creme: "Cream",
    brun: "Brown",
    rouge: "Red",
    orange: "Orange",
    ambre: "Amber",
    vert: "Green",
    turquoise: "Turquoise",
    bleu: "Blue",
    violet: "Purple",
    rose: "Pink",
    gris: "Grey",
  },
  expressions: {
    neutre: "Neutral",
    attentif: "Attentive",
    surpris: "Surprised",
    excite: "Excited",
    heureux: "Happy",
    hilare: "Laughing",
    colere: "Angry",
    triste: "Sad",
    effraye: "Scared",
    mefiant: "Suspicious",
    confus: "Confused",
    curieux: "Curious",
    fier: "Proud",
    timide: "Shy",
    blase: "Unimpressed",
    somnolent: "Sleepy",
  },
} as const;

export const format = {
  yesterday: "Yesterday",
} as const;
