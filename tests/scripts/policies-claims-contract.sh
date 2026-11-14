#!/usr/bin/env bash
set -euo pipefail

# Offline contract for the Settings > Policies page.
#
# Every rule sentence on that page (`settingsPolicies.*` in
# contracts/i18n/src/messages/{fr,en}/*.ts) carries an "Appliquée" badge that no
# runtime read computes. This contract ties each sentence to the code that
# makes it true: when a cited anchor moves or disappears, the sentence must be
# re-proven (and its anchor updated) or rewritten.
#
# (a) Every `settingsPolicies.<key>` claim below exists in both dictionaries.
# (b) Every claim key of the page is listed below: a new sentence needs an
#     anchor before it ships. Titles, labels, links and the three framing
#     descriptions are not claims.
# (c) Each anchor (file + fixed string) is present.
# (d) Forbidden patterns stay absent (shell channel, stored provider keys).

root="$(cd "$(dirname "$0")/../.." && pwd)"
# The catalogs are split by domain (contracts/i18n/src/messages/<locale>/*.ts):
# the namespace lives in whichever file exports it.
namespace_file() {
  grep -lE '^export const settingsPolicies = \{' "$root/contracts/i18n/src/messages/$1/"*.ts | head -n 1
}
fr="$(namespace_file fr)"
en="$(namespace_file en)"
errors=0

fail() { printf 'policies-claims-contract: %s\n' "$1" >&2; errors=$((errors + 1)); }

# claim key | file | fixed string that makes it true
anchors=(
  "approvalsDescription|modules/roster/src/domain/editor-directives.ts|if (!autoApprovesPermission(mode)) return false;"
  "approvalsDescription|modules/roster/src/domain/editor-directives.ts|if (isCircuitBreaker(text)) return false;"
  "approvalsDescription|modules/roster/src/domain/editor-directives.ts|if (mode === \"auto\" && isDeletion(text)) return false;"
  "approvalsDescription|modules/execution/src/application/runner/persist.ts|workerMayApproveGate(legacyMode, command) && choices.includes(\"once\")"
  "decisionValue|apps/api/src/routes/conversation/approval-routes.ts|if (choice !== \"once\" && choice !== \"deny\" && !always) {"
  "decisionValue|apps/api/src/routes/conversation/approval-always.ts|return auth.role === \"owner\" || auth.role === \"admin\";"
  "permanentValue|apps/api/src/routes/conversation/approval-routes.ts|const decided: DecisionChoice = always ? \"once\" : choice as DecisionChoice;"
  "permanentValue|apps/api/src/routes/conversation/approval-routes.ts|\"APPROVAL_CHOICE_INVALID\""
  "expiryValue|apps/api/src/routes/conversation/approval-routes.ts|\"APPROVAL_NOT_PENDING\""
  "expiryValue|apps/api/src/routes/conversation/approval-routes.ts|if (new Date(approval.expiresAt).getTime() <= Date.now()) {"
  "rolesValue|contracts/api/src/identity/workspaces.ts|export function canOperateWorkspace(role: string): boolean {"
  "rolesValue|contracts/api/src/identity/workspaces.ts|return role === \"owner\" || role === \"admin\";"
  "adminChannelValue|platform/config/src/api-config.ts|const runtimeAdminChannels: RuntimeAdminChannels = { local: false };"
  "draftValue|apps/api/src/routes/runtimes/runtime-routes.ts|routes.post(\"/test-draft\""
  "secretsValue|apps/api/src/routes/runtimes/runtime-admin-routes.ts|client.providerCredentialAdd(provider, apiKey, label)"
  "secretsValue|modules/roster/src/application/bot-profiles.ts|client.hostSetProfileCredential(profile, credential.provider, credential.apiKey, credential.label)"
  "isolationValue|platform/db/src/db.ts|export async function withTenant<T>("
  "transportValue|platform/config/src/api-config.ts|HERMES_ALLOW_INSECURE_ORIGINS must be empty in production; Hermes requires HTTPS."
  "journalValue|db/migrations/0007_approvals_decisions.sql|previous_hash text,"
  "journalValue|db/migrations/0080_worker_least_privilege.sql|drop policy if exists decisions_worker on decisions;"
  "journalValue|db/migrations/0100_approval_policy_resolution.sql|resolved_by_policy"
)

# (b) the page's claim keys: every *Value plus approvalsDescription.
not_claims=" title description enforcedBadge approvalsTitle decisionLabel permanentLabel expiryLabel decisionsLink runtimeTitle runtimeDescription rolesLabel adminChannelLabel draftLabel secretsLabel runtimeLink dataTitle dataDescription isolationLabel transportLabel journalLabel securityLink "
namespace_block() {
  awk '/^export const settingsPolicies = \{/{on=1; next} on && /^\} as const;/{exit} on' "$1"
}
block="$( [[ -n "$fr" ]] && namespace_block "$fr" )"
[[ -n "$block" ]] || fail "bloc settingsPolicies introuvable dans contracts/i18n/src/messages/fr/"
while read -r key; do
  [[ -z "$key" || "$not_claims" == *" $key "* ]] && continue
  printf '%s\n' "${anchors[@]}" | grep -q "^$key|" || fail "settingsPolicies.$key n'a aucune ancre de code"
done < <(printf '%s\n' "$block" | sed -nE 's/^  ([A-Za-z]+):.*/\1/p')

for entry in "${anchors[@]}"; do
  IFS='|' read -r key file needle <<<"$entry"
  # (a) the claim exists in both languages
  for dict in "$fr" "$en"; do
    namespace_block "$dict" | grep -qE "^  $key:" \
      || fail "settingsPolicies.$key absent de ${dict#"$root"/}"
  done
  # (c) the anchor is present
  if [[ ! -f "$root/$file" ]]; then
    fail "$key : fichier d'ancre manquant : $file"
  elif ! grep -qF -- "$needle" "$root/$file"; then
    fail "$key : ancre introuvable dans $file : $needle"
  fi
done

# (d) forbidden patterns
if grep -rnE 'spawn(Sync)?\(\s*\[\s*"ssh"' "$root/apps" "$root/modules" "$root/platform" \
    --include='*.ts' --exclude-dir=node_modules --exclude-dir=tests >/dev/null; then
  fail "adminChannelValue : un spawn ssh est revenu dans le code livré"
fi
if grep -rniE '\b(api_key|apikey|provider_secret)\b' "$root/db/migrations" >/dev/null; then
  fail "secretsValue : une migration stocke une clé fournisseur"
fi

if ((errors > 0)); then
  printf 'policies-claims-contract: %d erreur(s)\n' "$errors" >&2
  exit 1
fi
printf 'policies-claims-contract: ok (%d ancres)\n' "${#anchors[@]}"
