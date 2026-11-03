// Whether safeStorage protects the session with a real OS vault.
//
// On Linux without a recognised secret store (no GNOME Keyring or KWallet, an
// unknown desktop, --password-store=basic), Chromium falls back to the
// `basic_text` backend: the key is a constant built into Chromium, so
// "encrypted" tokens are readable by anyone who can read the file. That is no
// better than plain text, so it counts as no vault and the session stays in
// memory (token-store.ts). `backend` is only called on Linux.
export function hasRealVault(
  platform: NodeJS.Platform,
  encryptionAvailable: boolean,
  backend: () => string,
): boolean {
  if (!encryptionAvailable) return false;
  if (platform !== "linux") return true;
  const selected = backend();
  return selected !== "basic_text" && selected !== "unknown";
}
