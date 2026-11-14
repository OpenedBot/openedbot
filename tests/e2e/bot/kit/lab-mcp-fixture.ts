import { labMcpNames, parseLabMcpEvidence, type LabMcpAction, type LabMcpCall, type LabMcpEvidence, type LabMcpTarget } from './lab-mcp-contract';
import type { LabMcpCommand } from './lab-mcp-command';

/** Owns one nonce-bound profile entry. An ambiguous shell response never establishes ownership. */
export class LabMcpFixture {
  readonly serverName: string;
  readonly toolName: string;
  setupReconciled = false;
  private attempted = false;
  private owned = false;
  private removed = false;
  private privateSecret: string | null = null;
  private previous: LabMcpEvidence | null = null;

  constructor(readonly target: LabMcpTarget, private readonly command: LabMcpCommand) {
    ({ serverName: this.serverName, toolName: this.toolName } = labMcpNames(target));
  }

  get secret(): string {
    if (!this.privateSecret) throw new Error('The private MCP probe has not been confirmed.');
    return this.privateSecret;
  }

  private coordinates(): string {
    return `runtime=${this.target.runtimeId}, nonce=${this.target.nonce}, profile=${this.target.profile}`;
  }

  private async action(action: LabMcpAction): Promise<LabMcpEvidence> {
    // Revalidate even injected adapters; cleanup authority always comes from
    // the same exact runtime/nonce/profile receipt as initial setup.
    const result = parseLabMcpEvidence(JSON.stringify(await this.command(action)), this.target, action);
    if (this.previous) {
      const sameCalls = JSON.stringify(result.calls.slice(0, this.previous.calls.length)) === JSON.stringify(this.previous.calls);
      const identities = (evidence: LabMcpEvidence) => evidence.processes.map(({ pid, startTicks }) => ({ pid, startTicks }));
      const previousProcesses = identities(this.previous);
      if (!sameCalls || result.starts < this.previous.starts
        || JSON.stringify(identities(result).slice(0, this.previous.starts)) !== JSON.stringify(previousProcesses)) {
        throw new Error('Lab MCP ownership history regressed or changed; fixture evidence is inconsistent.');
      }
    }
    this.previous = result;
    return result;
  }

  private establish(evidence: LabMcpEvidence): void {
    this.owned = true;
    this.removed = evidence.removed;
  }

  async setup(): Promise<void> {
    if (this.attempted) throw new Error('This MCP fixture setup was already attempted.');
    this.attempted = true;
    let evidence: LabMcpEvidence;
    try { evidence = await this.action('setup'); }
    catch (failure) {
      let receipt: LabMcpEvidence;
      try { receipt = await this.action('receipts'); } catch {
        throw new Error(`MCP setup outcome is unconfirmed. Ownership could not be reconciled; no blind retry or removal is allowed. Reconcile ${this.coordinates()}.`, { cause: failure });
      }
      this.establish(receipt);
      if (receipt.removed) throw new Error('The owned MCP receipt is already removed; setup will not recreate it.', { cause: failure });
      // The root ownership receipt proves even an interrupted preparing
      // transaction belongs to us. The CLI resumes this exact operation.
      evidence = await this.action('setup');
      this.setupReconciled = true;
    }
    this.establish(evidence);
    if (!evidence.secret) throw new Error('The lab setup omitted its private probe.');
    this.privateSecret = evidence.secret;
  }

  async setOnline(online: boolean): Promise<void> {
    if (!this.owned || this.removed) throw new Error('The live MCP fixture is not owned.');
    await this.action(online ? 'online' : 'offline');
  }

  async receipts(): Promise<LabMcpCall[]> {
    return (await this.snapshot()).calls;
  }

  async snapshot(): Promise<LabMcpEvidence> {
    if (!this.owned || this.removed) throw new Error('The live MCP fixture is not owned.');
    return this.action('receipts');
  }

  async cleanup(): Promise<void> {
    if (!this.attempted || this.removed) return;
    if (!this.owned) {
      let receipt: LabMcpEvidence;
      try { receipt = await this.action('receipts'); } catch {
        throw new Error(`MCP cleanup refused: the exact ownership receipt is unavailable. Reconcile ${this.coordinates()} before removing anything.`);
      }
      this.establish(receipt);
      if (this.removed) return;
    }
    try { this.establish(await this.action('remove')); }
    catch (failure) {
      // A lost remove response can be confirmed read-only, never by
      // deleting a stale entry again under a guessed ownership scope.
      let receipt: LabMcpEvidence;
      try { receipt = await this.action('receipts'); } catch {
        throw new Error(`MCP removal outcome and ownership receipt are unavailable. Reconcile ${this.coordinates()}; no second delete was attempted.`, { cause: failure });
      }
      if (!receipt.removed) throw new Error(`MCP removal is unconfirmed; the exact owned receipt remains for recovery: ${this.coordinates()}.`, { cause: failure });
      this.establish(receipt);
    }
    this.privateSecret = null;
  }
}
