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
  if (all) printf "%sopenedbot: every documented command%s\n", S, R
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
    printf "  %s%-24s%s %s\n", T, name, R, (name in documented) ? documented[name] : "(undocumented)"
  }
}

END {
  if (all) {
    printf "\n"
    exit
  }
  printf "%sopenedbot: the daily commands, by mode%s\n", S, R
  mode("DEV", "this workstation: .env.local, PostgreSQL and Mailpit, remote runtime (or fake Hermes)", dev)
  mode("PREPROD", "pre-production environment: the API and its worker before production", preprod)
  mode("PROD", "production: the real customers", prod)
  mode("BEFORE PUSHING", "no mode: code, tests, contracts", check)
  printf "\n  First run           make setup, then make fake-hermes, then make dev (another terminal)\n"
  printf "  Real runtime        make link-dev-up HOST=user@host (instead of make fake-hermes)\n"
  printf "  Everything else     make help-all (e2e, build, private fragments)\n\n"
}
