import { requireLabMcpTarget, type LabMcpTarget } from './lab-mcp-contract';
import { labMcpProcessEnv, runLabMcpProcess } from './lab-mcp-process';

export const BROWSER_ACTIONS = ['setup', 'receipts', 'remove'] as const;
export type BrowserAction = typeof BROWSER_ACTIONS[number];
export type BrowserSidecar = {
  unit: string; invocationId: string; pid: number; startTicks: string;
  active: boolean; stopped: boolean; resourcesVerified: boolean;
};
export type BrowserEvidence = LabMcpTarget & {
  schemaVersion: 2; kind: 'browser-fixture'; action: BrowserAction;
  installed: boolean; removed: boolean; replayed: boolean; privateUrlException: boolean;
  placement: 'user-unit'; configRestored: boolean; sidecar: BrowserSidecar | null;
  backend: 'local'; executable: string; version: string; archiveSha256: string; target: string;
};
/** Flat recorder evidence keeps process identity visible without exposing the private CDP URL. */
export function browserSidecarDetail(evidence: BrowserEvidence) {
  const process = evidence.sidecar;
  return { placement: evidence.placement, sidecarObserved: process !== null, sidecarUnit: process?.unit ?? null,
    sidecarInvocationId: process?.invocationId ?? null, sidecarPid: process?.pid ?? null,
    sidecarStartTicks: process?.startTicks ?? null, sidecarActive: process?.active ?? false,
    sidecarStopped: process?.stopped ?? false, resourcesVerified: process?.resourcesVerified ?? false };
}
export type BrowserCommand = (action: BrowserAction) => Promise<BrowserEvidence>;

export function parseBrowserEvidence(output: string, identity: LabMcpTarget, action: BrowserAction): BrowserEvidence {
  requireLabMcpTarget(identity);
  if (new TextEncoder().encode(output).length > 32768) throw new Error('Browser fixture evidence exceeds 32 KiB.');
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw new Error('Browser fixture must return one JSON evidence document.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid browser fixture document.');
  const v = value as Record<string, unknown>;
  const fields = ['schemaVersion','kind','action','runtimeId','nonce','profile','installed','removed','replayed','privateUrlException','backend','executable','version','archiveSha256','target','placement','configRestored','sidecar'];
  if (Object.keys(v).sort().join() !== fields.sort().join() || v.schemaVersion !== 2 || v.kind !== 'browser-fixture'
    || v.action !== action || !BROWSER_ACTIONS.includes(action) || v.runtimeId !== identity.runtimeId || v.nonce !== identity.nonce
    || v.profile !== identity.profile || v.backend !== 'local' || v.placement !== 'user-unit'
    || ['installed','removed','replayed','privateUrlException','configRestored'].some((key) => typeof v[key] !== 'boolean')
    || ['executable','version','archiveSha256','target'].some((key) => typeof v[key] !== 'string' || String(v[key]).length > 4096)) {
    throw new Error('Browser fixture evidence does not match its exact owned target and schema.');
  }
  let sidecar: BrowserSidecar | null = null;
  if (v.sidecar !== null) {
    if (!v.sidecar || typeof v.sidecar !== 'object' || Array.isArray(v.sidecar)) throw new Error('Browser sidecar identity is missing or malformed.');
    const process = v.sidecar as Record<string, unknown>;
    if (Object.keys(process).sort().join() !== ['unit','invocationId','pid','startTicks','active','stopped','resourcesVerified'].sort().join()
      || typeof process.unit !== 'string' || process.unit !== `e2e-hermes-browser-${identity.nonce.replaceAll('-', '')}.service`
      || typeof process.invocationId !== 'string' || !/^[0-9a-f]{32}$/.test(process.invocationId)
      || !Number.isSafeInteger(process.pid) || Number(process.pid) <= 0
      || typeof process.startTicks !== 'string' || !/^[1-9][0-9]{0,23}$/.test(process.startTicks)
      || ['active','stopped','resourcesVerified'].some((key) => typeof process[key] !== 'boolean')
      || process.active && process.stopped || process.stopped && !process.resourcesVerified) {
      throw new Error('Browser sidecar process/unit/resource evidence is invalid.');
    }
    sidecar = v.sidecar as BrowserSidecar;
  }
  if (v.privateUrlException !== v.installed) throw new Error('Browser private exception does not match the owned config patch.');
  if (v.installed && (v.configRestored || !sidecar || !sidecar.resourcesVerified || !v.privateUrlException || v.removed || !String(v.executable).startsWith('/')
    || !v.version || !v.target || !/^[0-9a-f]{64}$/.test(String(v.archiveSha256)))) throw new Error('Installed browser fixture lacks pinned local artifact evidence.');
  if (v.removed && (v.installed || v.privateUrlException || !v.configRestored || sidecar && (sidecar.active || !sidecar.stopped || !sidecar.resourcesVerified))) throw new Error('Removed browser fixture still reports an owned exception.');
  if (action === 'setup' && (!sidecar?.active || sidecar.stopped)) throw new Error('Browser setup lacks a live owned user-unit process.');
  if (action === 'setup' && !v.installed || action === 'remove' && !v.removed) throw new Error('Browser fixture operation did not reach its required state.');
  return value as BrowserEvidence;
}

export async function executeBrowserCommand(argv: string[], target: LabMcpTarget, action: BrowserAction): Promise<BrowserEvidence> {
  requireLabMcpTarget(target);
  if (!argv.length || argv.some((arg) => typeof arg !== 'string' || !arg) || !BROWSER_ACTIONS.includes(action)) throw new Error('Explicit browser fixture argv/action required.');
  const output = await runLabMcpProcess(argv[0]!, argv.slice(1), {
    ...labMcpProcessEnv(process.env), E2E_ALLOW_LAB_FIXTURES: '1', E2E_BROWSER_ACTION: action,
    E2E_BROWSER_RUNTIME_ID: target.runtimeId, E2E_BROWSER_NONCE: target.nonce, E2E_BROWSER_PROFILE: target.profile,
  }, action === 'setup' ? 350_000 : 100_000, true, undefined, 360_000);
  return parseBrowserEvidence(output, target, action);
}

/** Cleanup authority comes only from the root-private receipt for this exact operation. */
export class LabBrowserFixture {
  private attempted = false;
  private owned = false;
  private removed = false;
  private observed: BrowserSidecar | null = null;
  private lastEvidence: BrowserEvidence | null = null;
  setupReconciled = false;
  constructor(readonly target: LabMcpTarget, private command: BrowserCommand) { requireLabMcpTarget(target); }
  private async action(action: BrowserAction): Promise<BrowserEvidence> {
    const evidence = parseBrowserEvidence(JSON.stringify(await this.command(action)), this.target, action);
    const identity = (value: BrowserSidecar) => JSON.stringify([value.unit, value.invocationId, value.pid, value.startTicks]);
    if (this.observed && (!evidence.sidecar || identity(evidence.sidecar) !== identity(this.observed))) {
      throw new Error('Browser sidecar identity changed or disappeared; ownership proof refused.');
    }
    if (this.observed?.stopped && evidence.sidecar && !evidence.sidecar.stopped) throw new Error('Stopped browser sidecar cannot become active again.');
    if (evidence.sidecar) this.observed = evidence.sidecar;
    this.lastEvidence = evidence;
    return evidence;
  }
  private establish(e: BrowserEvidence): void { this.owned = true; this.removed = e.removed; }
  private coordinates(): string { return `runtime=${this.target.runtimeId}, nonce=${this.target.nonce}, profile=${this.target.profile}`; }
  async setup(): Promise<BrowserEvidence> {
    if (this.attempted) throw new Error('Browser fixture setup already attempted.');
    this.attempted = true;
    let evidence: BrowserEvidence;
    try { evidence = await this.action('setup'); }
    catch (failure) {
      let receipt: BrowserEvidence;
      try { receipt = await this.action('receipts'); } catch {
        throw new Error(`Browser setup ownership unconfirmed; no blind retry/removal. Reconcile ${this.coordinates()}.`, { cause: failure });
      }
      this.establish(receipt);
      if (receipt.removed) throw new Error('Removed browser receipt cannot authorize recreation.', { cause: failure });
      evidence = await this.action('setup');
      this.setupReconciled = true;
    }
    this.establish(evidence);
    return evidence;
  }
  async cleanup(): Promise<BrowserEvidence | null> {
    if (!this.attempted || this.removed) return this.lastEvidence;
    if (!this.owned) {
      try { this.establish(await this.action('receipts')); } catch {
        throw new Error(`Browser cleanup ownership unconfirmed; reconcile ${this.coordinates()} before removal.`);
      }
      if (this.removed) return this.lastEvidence;
    }
    try { this.establish(await this.action('remove')); }
    catch (failure) {
      let receipt: BrowserEvidence;
      try { receipt = await this.action('receipts'); } catch {
        throw new Error(`Browser removal unconfirmed; no second delete. Reconcile ${this.coordinates()}.`, { cause: failure });
      }
      if (!receipt.removed) throw new Error(`Browser removal incomplete; exact owned receipt retained: ${this.coordinates()}.`, { cause: failure });
      this.establish(receipt);
    }
    return this.lastEvidence;
  }
}
