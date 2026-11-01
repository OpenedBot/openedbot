# `make help` and `make help-all`, read from the Makefile itself.
#
# A public target is documented on its own line: `name: [deps] ## description`.
# A leading `[TAG] ` in the description is dropped from the display: the
# section already says it.
#
# help      (default) the daily targets of each mode, named by the HELP_* lists
#           of the Makefile, passed in as dev, preprod, prod and check; a
#           mode with an empty list (no private fragment) is not shown.
# help-all  (all=1) every documented target, grouped by its section banner
#           (`# ─── Name ───`), in file order.
#
# Colors come in as S (section), T (target) and R (reset); empty with NO_COLOR.

BEGIN {
  FS = ":.*## "
  if (all) printf "%sOHB : toutes les commandes documentées%s\n", S, R
}

/^# ─── / {
  section = $0
  sub(/^# ─── /, "", section)
  sub(/ ─+$/, "", section)
  next
}

/^[a-zA-Z0-9_-]+:.*## / {
  description = $2
  sub(/^\[[^]]*\] /, "", description)
  documented[$1] = description
  if (all) {
    if (section != printed) {
      printf "\n%s%s%s\n", S, section, R
      printed = section
    }
    printf "  %s%-24s%s %s\n", T, $1, R, description
  }
}

function mode(title, where, list,    count, index_, names, name) {
  if (list == "") return
  printf "\n%s%s%s  %s\n", S, title, R, where
  count = split(list, names, " ")
  for (index_ = 1; index_ <= count; index_++) {
    name = names[index_]
    printf "  %s%-24s%s %s\n", T, name, R, (name in documented) ? documented[name] : "(non documentée)"
  }
}

END {
  if (all) {
    printf "\n"
    exit
  }
  printf "%sOHB : les commandes du quotidien, par mode%s\n", S, R
  mode("DEV", "ce poste : .env.local, PostgreSQL partagé, runtime distant (ou faux Hermes)", dev)
  mode("PREPROD", "environnement de préproduction : l'API et son worker avant la production", preprod)
  mode("PROD", "production : les vrais clients", prod)
  mode("AVANT DE POUSSER", "aucun mode : code, tests, contrats", check)
  printf "\n  Premier lancement   make setup, puis make dev, puis make link-dev-up HOST=user@hôte (autre terminal)\n"
  printf "  Tout le reste       make help-all (e2e, build, veille amont, worktrees)\n\n"
}
