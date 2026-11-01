#!/usr/bin/env bash
set -euo pipefail

# Offline contract between the schema, the code and db/ownership.json.
#
# Pass 1: every table that the migrations leave alive (created, never dropped)
# has an owning context in db/ownership.json, and every entry of that file
# names a table that still exists. Without this check a new migration silently
# adds a table nobody owns, and the "SQL lives with its owner" rule has no
# anchor.
#
# Pass 2: a module writes (insert into / update / delete from) only the tables
# it owns, or tables whose entry names it in `writers`. A `select` is not a
# write. The scan covers modules/*/src/sql/** and modules/*/src/application/**.
#
# An entry of db/ownership.json is either the owner's name:
#
#   "bots": "roster"
#
# or an object that also declares the contexts allowed to write the table in
# addition to its owner (a known cross-context write, to be removed or kept
# on purpose, never an accident):
#
#   "subscriptions": { "owner": "billing", "writers": ["identity"] }
#
# An object entry may also carry a dated `debt`: the table stays in the core
# schema although its owner is leaving (a plug-in), until `until`. Past that
# date the contract warns, it does not fail: the debt is due, not a new bug.
#
#   "staff_users": { "owner": "staff", "debt": { "until": "2026-12-31", "reason": "..." } }
#
# The reserved key `$migrations` holds the migrations that stay in the core
# for an owner that is leaving (a plug-in), each with its dated debt, under
# the same rule: past `until` the contract warns. A migration is never
# renumbered or moved before its debt is paid.
#
#   "$migrations": { "0139_permission_review.sql": { "owner": "permissions", "debt": { "until": "...", "reason": "..." } } }
#
# Owners are module names (modules/<name>), plus two technical owners:
# `db` (schema_migrations) and `webhooks` (a context served by apps/api that
# has no module yet). Writers are module names.

root="$(cd "$(dirname "$0")/../.." && pwd)"

python3 -I - "$root" <<'PY'
import datetime, json, pathlib, re, sys

root = pathlib.Path(sys.argv[1])
migrations, ownership = root / "db" / "migrations", root / "db" / "ownership.json"
create = re.compile(r"create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)", re.I)
drop = re.compile(r"drop\s+table\s+(?:if\s+exists\s+)?([a-z_][a-z0-9_ ,.]*?)\s*(?:cascade|restrict)?\s*;", re.I)

alive: set[str] = set()
for path in sorted(migrations.glob("*.sql")):
    sql = re.sub(r"--[^\n]*", "", path.read_text(encoding="utf-8"))
    for name in create.findall(sql):
        alive.add(name.lower())
    for group in drop.findall(sql):
        for name in group.split(","):
            alive.discard(name.strip().removeprefix("public.").lower())

entries = json.loads(ownership.read_text(encoding="utf-8"))
migration_entries = entries.pop("$migrations", {})
modules = sorted(p.name for p in (root / "modules").iterdir() if (p / "src").is_dir())
errors: list[str] = []
debts: dict[str, dict] = {}
today = datetime.date.today()

def valid_debt(debt) -> bool:
    if not (isinstance(debt, dict) and set(debt) == {"until", "reason"}):
        return False
    if not (isinstance(debt["reason"], str) and debt["reason"].strip()):
        return False
    try:
        datetime.date.fromisoformat(debt["until"])
    except (TypeError, ValueError):
        return False
    return True

# An entry is "owner" or {"owner": "x", "writers": ["y", ...]}.
owners: dict[str, str] = {}
writers: dict[str, set[str]] = {}
for table, entry in entries.items():
    if isinstance(entry, str):
        owners[table], writers[table] = entry, set()
    elif isinstance(entry, dict) and isinstance(entry.get("owner"), str) \
            and set(entry) <= {"owner", "writers", "debt"} \
            and isinstance(entry.get("writers", []), list) \
            and all(isinstance(w, str) for w in entry.get("writers", [])) \
            and ("debt" not in entry or valid_debt(entry["debt"])):
        owners[table], writers[table] = entry["owner"], set(entry.get("writers", []))
        if "debt" in entry:
            debts[table] = entry["debt"]
        for writer in sorted(writers[table]):
            if writer not in modules:
                errors.append(f"db-ownership-contract: {table} : writer inconnu (pas de modules/{writer}) : {writer}")
            if writer == owners[table]:
                errors.append(f"db-ownership-contract: {table} : {writer} est déjà propriétaire, pas writer")
    else:
        errors.append(f"db-ownership-contract: {table} : entrée invalide (chaîne ou {{owner, writers, debt: {{until, reason}}}} attendu)")

# Migrations kept in the core for a leaving owner.
migration_debts: dict[str, dict] = {}
if not isinstance(migration_entries, dict):
    errors.append("db-ownership-contract: $migrations : objet {fichier: {owner, debt}} attendu")
    migration_entries = {}
for name, entry in migration_entries.items():
    if not (migrations / name).is_file():
        errors.append(f"db-ownership-contract: $migrations : migration inconnue : {name}")
    elif not (isinstance(entry, dict) and set(entry) == {"owner", "debt"} and isinstance(entry["owner"], str)
              and entry["owner"].strip() and valid_debt(entry["debt"])):
        errors.append(f"db-ownership-contract: $migrations : {name} : entrée invalide ({{owner, debt: {{until, reason}}}} attendu)")
    else:
        migration_debts[name] = entry

# Pass 1: tables versus entries.
owned = set(entries)
missing, stale = sorted(alive - owned), sorted(owned - alive)
for name in missing:
    errors.append(f"db-ownership-contract: table vivante sans propriétaire : {name}")
for name in stale:
    errors.append(f"db-ownership-contract: entrée sans table : {name}")

# Pass 2: writes versus owners and declared writers. Comments are blanked
# (newlines kept) so the reported line numbers stay those of the file.
write = re.compile(
    r"\b(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?("
    + "|".join(sorted((re.escape(t) for t in owners), key=len, reverse=True))
    + r")\b",
    re.I,
)
blank = lambda m: re.sub(r"[^\n]", " ", m.group(0))
writes = 0
used: set[tuple[str, str]] = set()
if owners:
    for module in modules:
        for layer in ("sql", "application"):
            for path in sorted((root / "modules" / module / "src" / layer).rglob("*.ts")):
                text = path.read_text(encoding="utf-8")
                text = re.sub(r"/\*.*?\*/", blank, text, flags=re.S)
                text = re.sub(r"(?m)^[ \t]*//.*$", blank, text)
                for match in write.finditer(text):
                    table = match.group(1).lower()
                    writes += 1
                    if module in writers[table]:
                        used.add((table, module))
                    if module == owners[table] or module in writers[table]:
                        continue
                    line = text.count("\n", 0, match.start()) + 1
                    errors.append(
                        f"db-ownership-contract: {path.relative_to(root)}:{line} : "
                        f"{module} écrit {table} (propriétaire : {owners[table]}), "
                        f"à déclarer dans writers de db/ownership.json"
                    )

# A debt past its date is due: reported, never fatal.
for table in sorted(debts):
    until = datetime.date.fromisoformat(debts[table]["until"])
    if until < today:
        print(
            f"db-ownership-contract: avertissement : dette échue depuis le {until.isoformat()} sur {table} "
            f"({owners[table]}) : {debts[table]['reason']}",
            file=sys.stderr,
        )

for name in sorted(migration_debts):
    until = datetime.date.fromisoformat(migration_debts[name]["debt"]["until"])
    if until < today:
        print(
            f"db-ownership-contract: avertissement : dette échue depuis le {until.isoformat()} sur la migration {name} "
            f"({migration_debts[name]['owner']}) : {migration_debts[name]['debt']['reason']}",
            file=sys.stderr,
        )

# A writer that no longer writes is an exception to delete, not an error: the
# cross-context write it declared has just been fixed.
for table in sorted(writers):
    for writer in sorted(writers[table]):
        if (table, writer) not in used:
            print(
                f"db-ownership-contract: avertissement : {writer} n'écrit plus {table}, "
                f"retirer {writer} de ses writers",
                file=sys.stderr,
            )

for message in errors:
    print(message, file=sys.stderr)
if errors:
    sys.exit(1)
print(
    f"db-ownership-contract: {len(alive)} tables vivantes, toutes possédées ; "
    f"{writes} écritures de modules, toutes chez leur propriétaire ou un writer déclaré ; "
    f"{len(debts)} tables et {len(migration_debts)} migrations en dette datée."
)
PY
