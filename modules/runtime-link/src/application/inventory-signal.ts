import type { LinkIdentity, LinkLivenessStore, LinkLogger } from "./link-types";

/**
 * `inventory.changed` reçu sur une connexion : l'inscrire
 * (`runtimes.inventory_changed_at`), puis passer le runtime à l'application
 * pour une relecture en arrière-plan.
 *
 * Une écriture à la fois ; un signal reçu pendant celle-ci en programme UNE
 * autre : un hôte bavard coûte au plus deux écritures, et le dernier signal
 * n'est jamais perdu.
 */
export class InventorySignal {
  private writing = false;
  private pending = false;

  constructor(private readonly options: {
    liveness: LinkLivenessStore;
    log: LinkLogger;
    onInventoryChanged?: (link: LinkIdentity) => void;
    isClosed: () => boolean;
  }) {}

  receive(identity: LinkIdentity): void {
    if (this.writing) {
      this.pending = true;
      return;
    }
    void this.record(identity);
  }

  private async record(identity: LinkIdentity): Promise<void> {
    const persist = this.options.liveness.inventoryChanged;
    if (!persist) return;
    this.writing = true;
    try {
      do {
        this.pending = false;
        try {
          const marked = await persist.call(this.options.liveness, identity);
          // Ligne absente (révoqué, jeton tourné) : il n'y a rien à relire.
          if (marked && !this.options.isClosed()) this.options.onInventoryChanged?.(identity);
        } catch (error) {
          // Le signal suivant, ou la prochaine connexion, le rattrapera ; la
          // lecture de l'écran garde sa borne d'âge en attendant.
          this.options.log("runtime_link.inventory_changed_failed", { runtimeId: identity.runtimeId, error: String(error) });
        }
      } while (this.pending && !this.options.isClosed());
    } finally {
      this.writing = false;
    }
  }
}
