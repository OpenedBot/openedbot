/**
 * Traceur de latence d'un run (OHB-107), sans dépendance : il se charge
 * depuis l'API comme depuis le worker sans tirer pino.
 *
 * Une trace ne retient que des NOMS et des DURÉES : jamais un texte, un
 * identifiant de session ou une réponse Hermes. Un nom hors du motif est
 * ignoré, si bien qu'aucun contenu privé ne peut atteindre `run.latency`,
 * même par erreur d'appel.
 *
 * Les marques sont des décalages monotones (`performance.now()`) depuis
 * l'origine de la trace, propres à un processus : l'API et le worker ne
 * partagent pas d'horloge. Le pont entre les deux est `queuedMs`, mesuré par
 * PostgreSQL seul (création du run → réclamation).
 */

export type RunTraceClock = { now(): number; epoch(): number };

export type RunTraceAttribute = number | boolean | string;

export type RunTraceSummary = {
  startedAt: string;
  marks: Record<string, number>;
  spans: Record<string, number>;
  attributes: Record<string, RunTraceAttribute>;
};

const NAME = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_ENTRIES = 64;
const MAX_ACTIVE_TRACES = 1_024;

const systemClock: RunTraceClock = {
  now: () => performance.now(),
  epoch: () => Date.now(),
};

function validName(name: string): boolean {
  return name.length <= MAX_NAME_LENGTH && NAME.test(name);
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

export class RunTrace {
  private readonly origin: number;
  private readonly startedAtMs: number;
  private readonly marks = new Map<string, number>();
  private readonly spans = new Map<string, number>();
  private readonly attributes = new Map<string, RunTraceAttribute>();

  constructor(private readonly clock: RunTraceClock = systemClock, origin?: number) {
    const now = clock.now();
    this.origin = origin ?? now;
    this.startedAtMs = clock.epoch() - (now - this.origin);
  }

  /** La première occurrence gagne : une marque date toujours un « premier ». */
  mark(name: string): void {
    if (!validName(name) || this.marks.has(name) || this.marks.size >= MAX_ENTRIES) return;
    this.marks.set(name, roundMs(this.clock.now() - this.origin));
  }

  has(name: string): boolean {
    return this.marks.has(name);
  }

  offset(name: string): number | null {
    return this.marks.get(name) ?? null;
  }

  /** Mesure une étape et pose sa marque de fin, même quand elle échoue. */
  async span<T>(name: string, work: () => Promise<T> | T): Promise<T> {
    const startedAt = this.clock.now();
    try {
      return await work();
    } finally {
      if (validName(name) && !this.spans.has(name) && this.spans.size < MAX_ENTRIES) {
        this.spans.set(name, roundMs(this.clock.now() - startedAt));
      }
      this.mark(name);
    }
  }

  /** Une chaîne n'entre que si elle a la forme d'un nom : un état, pas une donnée. */
  set(name: string, value: RunTraceAttribute): void {
    if (!validName(name) || this.attributes.size >= MAX_ENTRIES) return;
    if (typeof value === "number" && !Number.isFinite(value)) return;
    if (typeof value === "string" && !validName(value)) return;
    this.attributes.set(name, typeof value === "number" ? roundMs(value) : value);
  }

  summary(): RunTraceSummary {
    return {
      startedAt: new Date(this.startedAtMs).toISOString(),
      marks: Object.fromEntries(this.marks),
      spans: Object.fromEntries(this.spans),
      attributes: Object.fromEntries(this.attributes),
    };
  }
}

// Le worker réclame le run, le module d'exécution le déroule : la trace
// passe de l'un à l'autre par son identifiant. Une trace jamais close est
// évincée par ancienneté plutôt que de grossir sans fin.
const active = new Map<string, RunTrace>();

export function startRunTrace(runId: string, trace: RunTrace = new RunTrace()): RunTrace {
  active.delete(runId);
  active.set(runId, trace);
  while (active.size > MAX_ACTIVE_TRACES) {
    const oldest = active.keys().next().value;
    if (oldest === undefined) break;
    active.delete(oldest);
  }
  return trace;
}

export function runTrace(runId: string): RunTrace | undefined {
  return active.get(runId);
}

export function endRunTrace(runId: string): RunTrace | undefined {
  const trace = active.get(runId);
  active.delete(runId);
  return trace;
}

/**
 * Trois seuils distincts (critère 5 d'OHB-107) : l'admission locale de l'API,
 * le premier événement du runtime et le premier texte visible, les deux
 * derniers comptés depuis la création du run. Valeurs provisoires, à caler
 * sur le relevé de 20 messages (OHB-119).
 */
export const RUN_LATENCY_BUDGETS_MS = {
  admission: 250,
  firstRuntimeEvent: 2_500,
  firstVisibleText: 4_000,
} as const;

export type RunLatencyStage = keyof typeof RUN_LATENCY_BUDGETS_MS;

export type RunLatencyVerdict = { ms: number; budgetMs: number; pass: boolean };

export function runLatencyVerdicts(
  measured: Partial<Record<RunLatencyStage, number | null>>,
  budgets: Record<RunLatencyStage, number> = RUN_LATENCY_BUDGETS_MS,
): Partial<Record<RunLatencyStage, RunLatencyVerdict>> {
  const verdicts: Partial<Record<RunLatencyStage, RunLatencyVerdict>> = {};
  for (const stage of Object.keys(budgets) as RunLatencyStage[]) {
    const ms = measured[stage];
    if (typeof ms !== "number" || !Number.isFinite(ms)) continue;
    verdicts[stage] = { ms: roundMs(ms), budgetMs: budgets[stage], pass: ms <= budgets[stage] };
  }
  return verdicts;
}

/**
 * La ligne `run.latency` du worker. Les seuils côté runtime se comptent
 * depuis la création du run : `queuedMs` (horloge PostgreSQL) plus le
 * décalage de la marque depuis l'origine de la trace, posée à la réclamation.
 */
export function runLatencyRecord(input: {
  runId: string;
  organizationId: string;
  queuedMs: number | null;
  trace: RunTrace;
}): Record<string, unknown> {
  const summary = input.trace.summary();
  const sinceCreated = (mark: string): number | null => {
    const offset = summary.marks[mark];
    return input.queuedMs === null || offset === undefined ? null : input.queuedMs + offset;
  };
  return {
    runId: input.runId,
    organizationId: input.organizationId,
    queuedMs: input.queuedMs,
    ...summary,
    verdicts: runLatencyVerdicts({
      firstRuntimeEvent: sinceCreated("hermes.first_event"),
      firstVisibleText: sinceCreated("ohb.first_text_published"),
    }),
  };
}
