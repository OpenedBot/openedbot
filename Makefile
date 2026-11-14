SHELL := /bin/bash
.DEFAULT_GOAL := help
# Réglages propres au poste, jamais versionnés (.gitignore) : Makefile.local,
# s'il existe, peut poser par exemple LINK_DEV_HOST=user@your-vm.
-include $(CURDIR)/Makefile.local

# ─── Configuration ───────────────────────────────────────────────────────────

ENV_FILE ?= .env.local
# Development profile: fake (default, tests/fake-hermes), bundled (Docker Hermes)
# or external (operator-provided runtime). The apps always run in the external
# runtime mode; the profile only decides which runtime setup.sh points them at.
# An explicit MODE=<profile> always wins. Otherwise the profile follows
# DEV_HERMES_URL in $(ENV_FILE), so that an existing workstation keeps its
# profile without repeating MODE= on every command:
#   DEV_HERMES_URL absent, empty or the fake gateway   -> fake
#   DEV_HERMES_URL=<any other runtime>                 -> external
# The fake gateway URL is the one scripts/setup.sh writes for the fake profile.
FAKE_HERMES_URL := http://127.0.0.1:18642
env_file_value = $(strip $(lastword $(shell sed -n 's/^$(1)=//p' "$(ENV_FILE)" 2>/dev/null)))
ENV_FILE_HERMES_URL := $(call env_file_value,DEV_HERMES_URL)

ifeq ($(ENV_FILE_HERMES_URL),)
MODE ?= fake
else ifeq ($(ENV_FILE_HERMES_URL),$(FAKE_HERMES_URL))
MODE ?= fake
else
MODE ?= external
endif

# Une variable, un fichier, et ce fichier est celui de la racine : API,
# worker, console, Makefile et scripts y puisent tous
# (platform/config/src/env-schema.ts, ENV_DIR_OF_SCOPE, toutes portées
# à « . »). Les applications n'ont plus de .env voisin : ce sont ces recettes
# qui sourcent le fichier et EXPORTENT (set -a) avant de lancer un processus,
# Vite compris ; un `bun run --cwd apps/api dev` lancé à la main ne charge
# donc plus rien.
ENV_FILES = $(ENV_FILE)
LOAD_ENV_FILES = set -a; for env_file in $(ENV_FILES); do if [ -f "$$env_file" ]; then . "$$env_file"; fi; done; set +a;
LOAD_ENV = if [ ! -f "$(ENV_FILE)" ]; then printf '%s is missing. Run make setup.\n' "$(ENV_FILE)" >&2; exit 1; fi; $(LOAD_ENV_FILES)
LOAD_ENV_OPT = $(LOAD_ENV_FILES)

# Les cibles e2e qui parlent à l'API locale vérifient d'abord qu'elle répond.
REQUIRE_API = $(LOAD_ENV_OPT) curl -fsS "http://127.0.0.1:$${API_PORT:-8790}/api/health" >/dev/null 2>&1 \
	|| { echo "API cloud locale indisponible: lancer « make dev » dans un autre terminal." >&2; exit 1; }

# Pas de --no-orphans : le lanceur tuait toute la descendance dès que le
# script intermédiaire tombait sur Ctrl-C, l'API en plein arrêt comprise
# (pas de `stopped_at`, liens laissés à une instance morte). Ctrl-C et la
# fermeture du terminal atteignent déjà chaque processus du groupe ;
# `make stop` reste le filet si `make` est tué seul.
# Par défaut `make dev` ne lance pas l'app desktop (« openedbot dev », tauri
# dev en hot reload) : `make desktop` la lance seule, DESKTOP=1 l'ajoute à
# `make dev`. Sans cargo, elle est sautée avec un message.
DESKTOP ?= 0
DESKTOP_DEV_PORT ?= 1422
export DESKTOP_DEV_PORT
DEV_COMMAND ?= bun run --filter api --filter console --filter worker $(if $(filter 1,$(DESKTOP)),--filter desktop-tauri) --parallel --elide-lines=0 dev
DEV_API_COMMAND ?= bun run --cwd apps/api --silent dev
DEV_CONSOLE_COMMAND ?= bun run --cwd apps/console --silent dev
DEV_WORKER_COMMAND ?= bun run --cwd apps/worker --silent dev

# Plug-ins externes : par convention le répertoire plugins/ à la racine de ce
# checkout, ignoré par git (clone ou lien symbolique du checkout des plug-ins :
# `ln -s <checkout des plug-ins> plugins`). Détecté s'il existe ; absent, le
# cœur tourne en solo et ne nomme aucun chemin de plug-in.
plugins_dir := $(if $(wildcard $(CURDIR)/plugins/.),$(CURDIR)/plugins)

# ─── Colors ──────────────────────────────────────────────────────────────────
# Définies une fois, réutilisées par les recettes qui parlent à l'utilisateur.
# `NO_COLOR` les vide, comme le fait déjà `help`.
ifeq ($(NO_COLOR),)
C_SECTION := \033[1;33m
C_TARGET  := \033[36m
C_OK      := \033[32m
C_WARN    := \033[33m
C_ERR     := \033[31m
C_RESET   := \033[0m
# Préfixes des processus de `make dev` (API / CONSOLE / WORKER / DESKTOP / autre).
C_DEV_API     := \033[1;35m
C_DEV_CONSOLE := \033[1;36m
C_DEV_WORKER  := \033[1;32m
C_DEV_DESKTOP := \033[1;34m
C_DEV_OTHER   := \033[1;33m
else
C_SECTION :=
C_TARGET  :=
C_OK      :=
C_WARN    :=
C_ERR     :=
C_RESET   :=
C_DEV_API     :=
C_DEV_CONSOLE :=
C_DEV_WORKER  :=
C_DEV_DESKTOP :=
C_DEV_OTHER   :=
endif

# ─── Help ────────────────────────────────────────────────────────────────────
.PHONY: help help-all

# Les cibles du quotidien, par mode ; toutes les autres restent dans help-all.
HELP_DEV     := setup fake-hermes dev stop link-dev-up link-dev-status link-dev-down db-migrate db-reset-keep-users
# Les fragments privés (plugins/make/*.mk, en fin de fichier) y ajoutent leurs cibles.
HELP_PREPROD :=
HELP_PROD    := link-prod
HELP_CHECK   := typecheck test-unit test-integration check
HELP_AWK = awk -v S="$(C_SECTION)" -v T="$(C_TARGET)" -v R="$(C_RESET)" \
	-v dev="$(HELP_DEV)" -v preprod="$(HELP_PREPROD)" -v prod="$(HELP_PROD)" -v check="$(HELP_CHECK)" \
	-f scripts/make-help.awk

help: ## The daily commands, by mode.
	@$(HELP_AWK) $(MAKEFILE_LIST)

help-all: ## Every documented command, by section.
	@$(HELP_AWK) -v all=1 $(MAKEFILE_LIST)

# ─── Dev: workstation setup ──────────────────────────────────────────────────
.PHONY: setup env-check env-audit env-prune env-template env-where env-prod-list

setup: ## Prepares local development end to end (env, dependencies, PostgreSQL + Mailpit, data).
	ENV_FILE="$(ENV_FILE)" OPENEDBOT_DEV_PROFILE="$(MODE)" bash scripts/setup.sh

env-check: ## Strictly validates .env.local.
	ENV_FILE="$(ENV_FILE)" bun scripts/env.ts --check

env-audit: ## Checks the templates and prints only the superfluous names of .env.local.
	ENV_FILE="$(ENV_FILE)" bun scripts/env.ts --audit

env-prune: ## Removes non-development variables from .env.local, only when they are empty.
	ENV_FILE="$(ENV_FILE)" bun scripts/env.ts --audit --apply

env-template: ## Regenerates .env.example from platform/config/src/env-schema.ts.
	bun scripts/env.ts --template --write

env-where: ## Where a variable is declared and which file must hold it (NAME=API_PORT; without NAME, the whole schema).
	@ENV_FILE="$(ENV_FILE)" bun scripts/env.ts --where $(NAME)

env-prod-list: ## Prints the production template (no production file is versioned; values live in the secret manager).
	@bun scripts/env.ts --template --print-production

# ─── Dev: database and services ──────────────────────────────────────────────
.PHONY: db-up infra-up mailpit-up fake-hermes fake-apns db-migrate db-seed db-reset db-reset-keep-users runtime-token-rotate

db-up: ## [DB] Checks the development PostgreSQL (restarted when stopped; created from compose.dev.yml only with OPENEDBOT_DEV_INFRA=compose); never Hermes.
	$(LOAD_ENV_OPT) bash scripts/db.sh --up

# Alias historique de db-up (scripts/setup.sh, scripts/db.sh) : hors de l'aide.
infra-up:
	$(LOAD_ENV_OPT) bash scripts/db.sh --up

mailpit-up: ## [INFRA] Checks the development Mailpit (created from compose.dev.yml only with OPENEDBOT_DEV_INFRA=compose): development SMTP on :1025, messages on :8025.
	$(LOAD_ENV_OPT) bash scripts/mailpit.sh

fake-hermes: ## [FAKE] Serves the fake Hermes gateway on 127.0.0.1:18642 in the foreground (fake profile).
	$(LOAD_ENV_OPT) FAKE_HERMES_TOKEN="$${DEV_HERMES_TOKEN:-}" bun tests/fake-hermes/server.ts

fake-apns: ## [FAKE] Serves the fake HTTP/2 (h2c) APNs on 127.0.0.1:18793 in the foreground; "bun tests/fake-apns/server.ts --dev-key" prints the APNS_* values to set.
	bun tests/fake-apns/server.ts

db-migrate: ## [DB] Applies the migrations; requires the infrastructure to be running already.
	$(LOAD_ENV_OPT) bash scripts/db.sh --migrate

db-seed: db-migrate env-check ## Creates the development account, organization, subscription and Hermes.
	$(LOAD_ENV) ENV_FILE="$(abspath $(ENV_FILE))" OPENEDBOT_DEV_PROFILE="$(MODE)" bun run --filter api seed

# env-check runs before the database is dropped: an invalid .env.local must
# fail while the data is still there. The reset is a drop/create of the single
# openedbot database inside the shared dev-infra container (db-up only
# proves it is reachable); no compose project, container or volume is removed.
db-reset: env-check ## [DB] Starts again from an empty openedbot database (drop/create in the development PostgreSQL); requires CONFIRM=yes.
ifneq ($(CONFIRM),yes)
	$(error db-reset détruit les données locales de développement : la base openedbot du PostgreSQL partagé est supprimée puis recréée. Relancez avec CONFIRM=yes pour confirmer)
endif
	$(LOAD_ENV_OPT) bash scripts/db.sh --up
	$(LOAD_ENV_OPT) bash scripts/db.sh --reset --yes
	$(MAKE) db-migrate db-seed
	@printf 'Base vierge prête ; l’API et le worker de make dev se reconnectent seuls, sinon relancez make dev.\n'

# Jumeau terminal de POST /api/onboarding/reset {"scope":"full"} : mêmes tables
# préservées, même code (apps/api/src/application/dev-reset.ts). La base n'est
# PAS recréée et les migrations ne rejouent pas : seules les données
# applicatives partent, la partie utilisateur (users, organizations,
# memberships, sessions, subscriptions) reste, donc la session
# ouverte dans la console survit.
db-reset-keep-users: env-check ## [DB] Empties the local application data but keeps the user session (replays onboarding); requires CONFIRM=yes.
ifneq ($(CONFIRM),yes)
	$(error db-reset-keep-users détruit les données applicatives locales (bots, fils, runs, runtimes...). La partie utilisateur est conservée. Relancez avec CONFIRM=yes pour confirmer)
endif
	$(LOAD_ENV_OPT) bash scripts/db.sh --up
	$(LOAD_ENV_OPT) OPENEDBOT_DEV_RESET_CONFIRM=yes bun apps/api/scripts/dev-reset-data.ts
	@printf '$(C_OK)[make]$(C_RESET) Données applicatives vidées ; vous êtes toujours connecté, l’accueil se rejoue.\n'

runtime-token-rotate: db-migrate env-check ## Atomically re-encrypts the tokens with the current key.
	$(LOAD_ENV) bun apps/api/scripts/rotate-runtime-token-key.ts

# ─── Dev: run the apps ───────────────────────────────────────────────────────
.PHONY: dev dev-api dev-console dev-worker preview-console stop

# format_dev_logs ignore INT/TERM/HUP et lit jusqu'à la fin du tuyau : mort
# le premier sur Ctrl-C, il cassait le tuyau sous les apps en plein arrêt.
dev: env-check ## [API + CONSOLE + WORKER] Validates .env.local then starts the apps, without the desktop app (`make desktop` separately, DESKTOP=1 to add it); no infrastructure, no migration. MODE=fake|bundled|external forces the profile.
	@set -eo pipefail; $(LOAD_ENV) \
	format_dev_logs() { \
		local line label color payload; \
		trap '' INT TERM HUP; \
		while IFS= read -r line || [[ -n "$$line" ]]; do \
			case "$$line" in \
				api:*" | "*) label="API"; color="$(C_DEV_API)"; payload="$${line#*| }" ;; \
				console:*" | "*) label="CONSOLE"; color="$(C_DEV_CONSOLE)"; payload="$${line#*| }" ;; \
				worker:*" | "*) label="WORKER"; color="$(C_DEV_WORKER)"; payload="$${line#*| }" ;; \
				desktop-tauri:*" | "*) label="DESKTOP"; color="$(C_DEV_DESKTOP)"; payload="$${line#*| }" ;; \
				*) label="DEV"; color="$(C_DEV_OTHER)"; payload="$$line" ;; \
			esac; \
			if [[ -n "$${NO_COLOR:-}" ]]; then \
				printf '[%s] %s\n' "$$label" "$$payload"; \
			else \
				printf '%b[%s]%b %s\n' "$$color" "$$label" "$(C_RESET)" "$$payload"; \
			fi; \
		done; \
	}; \
	ENV_FILE="$(ENV_FILE)" bun scripts/dev-accounts.ts; \
	$(DEV_COMMAND) 2>&1 | format_dev_logs

dev-api: env-check ## [API] Starts the API only; infrastructure already running.
	$(LOAD_ENV) $(DEV_API_COMMAND)

dev-console: ## [CONSOLE] Starts Vite only, on :1420.
	$(LOAD_ENV_OPT) $(DEV_CONSOLE_COMMAND)

dev-worker: env-check ## [WORKER] Processes runs/workflows; API and infrastructure separately.
	$(LOAD_ENV) $(DEV_WORKER_COMMAND)


preview-console: build-console ## Serves the console dist on :1420 (same origin as make dev). Incompatible with vite.
	$(LOAD_ENV_OPT) bun run --filter console preview

# `make stop` arrête l'environnement de dev local en entier : API, worker,
# console et app desktop de dev (son lanceur relaie l'arrêt à
# tauri dev, qui ferme son Vite et l'app ; l'app installée n'est pas touchée). Le port ne suffisait pas. Le worker
# n'écoute rien, il survivait donc à chaque arrêt, et deux `make dev` empilés
# finissaient par poser deux workers sur la même file : un run pouvait rester
# en file sans que personne ne le prenne.
#
# Les processus sont reconnus à leur répertoire de travail sous `apps/`, pas
# à un motif de ligne de commande : `bun --watch src/index.ts` est le même
# texte pour l'API, le worker et n'importe quel autre dépôt ouvert à côté.
# Ce qui a sa propre cible n'est pas touché : ni le faux Hermes, ni le lien
# connecteur (`make link-dev-down`).
#
# PORT=<n> garde l'ancien usage : libérer ce seul port, et rien d'autre.
stop: ## [DEV] Stops the local environment (API, worker, console, desktop app "openedbot dev"). PORT=<n> frees a single port.
	@set -eo pipefail; $(LOAD_ENV_OPT) \
	if ! command -v lsof >/dev/null 2>&1; then \
		printf '$(C_ERR)[make]$(C_RESET) lsof est requis pour trouver les processus à arrêter.\n' >&2; exit 1; \
	fi; \
	free_port() { \
		port="$$1"; label="$$2"; \
		case "$$port" in ''|*[!0-9]*) printf '$(C_ERR)[make]$(C_RESET) Port invalide : %s.\n' "$$port" >&2; return 2 ;; esac; \
		if [ "$$port" -lt 1 ] || [ "$$port" -gt 65535 ]; then \
			printf '$(C_ERR)[make]$(C_RESET) Port hors limites : %s.\n' "$$port" >&2; return 2; \
		fi; \
		pids="$$(lsof -nP -iTCP:"$$port" -sTCP:LISTEN -t 2>/dev/null || true)"; \
		if [ -z "$$pids" ]; then \
			printf '$(C_OK)[make]$(C_RESET) %s : port %s déjà libre.\n' "$$label" "$$port"; return 0; \
		fi; \
		printf '$(C_WARN)[make]$(C_RESET) %s : arrêt du port %s (%s).\n' "$$label" "$$port" "$$(echo $$pids | tr '\n' ' ')"; \
		kill $$pids 2>/dev/null || true; \
		for _ in 1 2 3 4 5; do \
			pids="$$(lsof -nP -iTCP:"$$port" -sTCP:LISTEN -t 2>/dev/null || true)"; \
			[ -z "$$pids" ] && break; sleep 0.2; \
		done; \
		if [ -n "$$pids" ]; then \
			printf '$(C_WARN)[make]$(C_RESET) %s : toujours vivant après SIGTERM, SIGKILL (%s).\n' "$$label" "$$(echo $$pids | tr '\n' ' ')"; \
			kill -9 $$pids 2>/dev/null || true; sleep 0.3; \
		fi; \
		if [ -n "$$(lsof -nP -iTCP:"$$port" -sTCP:LISTEN -t 2>/dev/null || true)" ]; then \
			printf '$(C_ERR)[make]$(C_RESET) %s : le port %s est toujours occupé.\n' "$$label" "$$port" >&2; return 1; \
		fi; \
		printf '$(C_OK)[make]$(C_RESET) %s : port %s libéré.\n' "$$label" "$$port"; return 0; \
	}; \
	web_port="$$(printf '%s' "$${WEB_APP_URL:-}" | sed -n 's#^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]*:\([0-9]\{1,5\}\).*$$#\1#p')"; \
	web_port="$${web_port:-1420}"; \
	if [ -n "$(PORT)" ]; then free_port "$(PORT)" "Port demandé"; exit $$?; fi; \
	root="$(CURDIR)"; \
	skip=" "; ancestor=$$$$; \
	while [ -n "$$ancestor" ] && [ "$$ancestor" -gt 1 ] 2>/dev/null; do \
		skip="$$skip$$ancestor "; \
		ancestor="$$(ps -o ppid= -p "$$ancestor" 2>/dev/null | tr -d ' ')"; \
	done; \
	targets=""; \
	for pid in $$(pgrep -x bun 2>/dev/null || true) $$(pgrep -x node 2>/dev/null || true); do \
		case "$$skip" in *" $$pid "*) continue ;; esac; \
		cwd="$$(lsof -a -p "$$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"; \
		[ -n "$$cwd" ] || continue; \
		case "$$cwd" in \
			"$$root"/apps/api|"$$root"/apps/worker|"$$root"/apps/console|"$$root"/$(DESKTOP_TAURI_DIR)) \
				targets="$$targets $$pid" ;; \
			"$$root") \
				case "$$(ps -o command= -p "$$pid" 2>/dev/null)" in \
					*--filter*dev*) targets="$$targets $$pid" ;; \
				esac ;; \
		esac; \
	done; \
	if [ -n "$$targets" ]; then \
		printf '$(C_WARN)[make]$(C_RESET) Arrêt des apps de ce dépôt :%s\n' "$$targets"; \
		kill $$targets 2>/dev/null || true; \
		for _ in 1 2 3 4 5 6 7 8 9 10; do \
			alive=""; for pid in $$targets; do kill -0 "$$pid" 2>/dev/null && alive="$$alive $$pid"; done; \
			[ -z "$$alive" ] && break; sleep 0.2; \
		done; \
		if [ -n "$$alive" ]; then \
			printf '$(C_WARN)[make]$(C_RESET) Toujours vivant après SIGTERM, SIGKILL :%s\n' "$$alive"; \
			kill -9 $$alive 2>/dev/null || true; sleep 0.3; \
		fi; \
	else \
		printf '$(C_OK)[make]$(C_RESET) Aucune app de ce dépôt en cours.\n'; \
	fi; \
	status=0; \
	free_port "$$web_port" "Console" || status=$$?; \
	free_port "$${API_PORT:-8790}" "API" || status=$$?; \
	exit $$status

# ─── Dev: link to a remote runtime ───────────────────────────────────────────
.PHONY: link-dev-up link-dev-down link-dev-status link-mode link-dev-verify link-gateway-install

# TICKET=ask : le ticket est ouvert dans la console (Réglages, Installation,
# fenêtre d'appairage) puis collé sans écho, au lieu de la connexion du compte
# dev. Le runtime arrive alors dans l'espace de celui qui l'a ouvert, un compte
# Google compris, et l'instance est reprise même déjà liée.
# HOST= sur la ligne de commande l'emporte ; sinon LINK_DEV_HOST (Makefile.local).
LINK_DEV_HOST ?=
link_dev_host = $(or $(HOST),$(LINK_DEV_HOST))

link-dev-up: ## [DEV] Links a remote runtime to this workstation: gateway, tunnel, enrollment, in the background (HOST=user@host, otherwise LINK_DEV_HOST from Makefile.local; TICKET=ask: ticket pasted from the console).
	@ENV_FILE="$(ENV_FILE)" HOST="$(link_dev_host)" LINK_DEV_TICKET="$(TICKET)" bash scripts/link-dev-pass.sh up

link-dev-down: ## [DEV] Stops what `link-dev-up` started, and nothing else.
	@ENV_FILE="$(ENV_FILE)" bash scripts/link-dev-pass.sh down

link-dev-status: ## [DEV] What runs of the dev link: API, gateway, tunnel, last log line.
	@ENV_FILE="$(ENV_FILE)" bash scripts/link-dev-pass.sh status

link-mode: ## [DEV] What each link of the VPS targets, dev or production, and how to switch (HOST=user@vps, otherwise LINK_DEV_HOST from Makefile.local).
	@ENV_FILE="$(ENV_FILE)" HOST="$(link_dev_host)" bash scripts/link-dev-pass.sh modes

link-dev-verify: ## [DEV] Browser pass of /settings/runtime in a throwaway Chrome (opens a 5-minute local ticket; reaches no host).
	@ENV_FILE="$(ENV_FILE)" bash scripts/link-dev-pass.sh verify

link-gateway-install: ## [HERMES] Installs the systemd user service without starting it or enabling it at boot.
	@bun scripts/runtime-link-service.ts --install

# ─── Quality ─────────────────────────────────────────────────────────────────
.PHONY: typecheck deps-check license-check test-unit test-dual solo-check pro-check bundle-budget test-integration test-trace-legacy test check

typecheck: ## Typechecks every active workspace, then tests/, scripts/ and apps/console/scripts (root tsconfig.json).
	bun run --filter api --filter worker --filter link-gateway --filter console --filter desktop-tauri --filter @openedbot/hermes --filter @openedbot/platform-config --filter @openedbot/platform-db --filter @openedbot/platform-integrations --filter @openedbot/platform-observability --filter @openedbot/platform-plugins --filter '@openedbot/contracts-*' --filter @openedbot/protocol-connector --filter '@openedbot/browser-*' --filter './modules/*' typecheck
	bunx tsc --noEmit -p tsconfig.json

# Seules les couches présentes sont passées : dependency-cruiser refuse un
# chemin absent. tests/ et scripts/ sont cruisés
# avec le reste. L'alias `@/` de chaque application n'est résolu qu'avec son
# propre tsconfig : deux passes ciblées l'ajoutent pour voir les cycles internes.
deps-check: ## Boundaries between apps, packages and layers (.dependency-cruiser.cjs), tests/ and scripts/ included, without a build.
	bun tests/scripts/workspace-deps-contract.ts
	bun tests/scripts/permission-port-contract.ts
	bun tests/scripts/subscription-port-contract.ts
	bun tests/scripts/payment-provider-contract.ts
	bun tests/scripts/open-core-boundary-contract.ts
	bunx depcruise --config .dependency-cruiser.cjs --output-type err $(wildcard apps platform contracts protocol/connector browser modules tests scripts)
	bunx depcruise --config .dependency-cruiser.cjs --output-type err --ts-config $(CURDIR)/apps/console/tsconfig.json apps/console
	$(MAKE) --no-print-directory license-check

license-check: ## Licenses of the third-party packages of bun.lock (transitive included): no GPL nor AGPL; LGPL and MPL listed.
	bun scripts/license-scan.ts

UNIT_CONSOLE_BATCH_SIZE ?= 1

test-unit: ## Unit tests of API, worker, web, contracts, platform, modules and scripts, without network or PostgreSQL.
	bun test $$(find apps/api/tests -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) ! -name '*.e2e.test.ts' | sort) apps/worker/tests apps/link-gateway/tests contracts/api/tests contracts/i18n/tests contracts/primitives/tests protocol/connector/tests browser/api-client/src browser/face/src browser/ui-kit/src platform/hermes/tests platform/config/tests platform/db/tests platform/integrations/tests platform/observability/tests platform/plugins/tests $(wildcard modules/*/tests) tests/fake-hermes tests/fake-push tests/fake-apns
	bun test scripts/lib tests/e2e/bot/kit tests/scripts/run-writes-contract.test.ts tests/scripts/run-events-contract.test.ts tests/scripts/runtime-client-contract.test.ts tests/scripts/foreign-reads-contract.test.ts tests/scripts/release-workflows-contract.test.ts apps/desktop-tauri/scripts
	python3 -B tests/scripts/provider-fault-cleanup.test.py
	# Découverte automatique : tout *.test.ts(x) sous apps/console/tests joue,
	# sauf tests/e2e/ (parcours applicatifs complets, déjà couverts nommément
	# par e2e-fresh-setup / e2e-onboarding). Une suppression de
	# test ne peut plus passer inaperçue : elle fait juste baisser le compte
	# affiché par `bun test`, il n'y a plus de chemin à oublier de retirer.
	#
	# Par paquets bornés, pas en un seul processus : la suite entière
	# dans un même `bun test` a atteint 10,9 Go de mémoire résidente, et Bun
	# 1.3.14 y mourait d'un SIGTRAP après le dernier fichier, sans résumé ni
	# trace (CI 34595318772). Le tri rend l'ordre déterministe, `xargs` joue
	# TOUS les paquets et sort en 123 dès qu'un seul est rouge, donc un échec
	# ne masque pas les suivants, et la découverte reste automatique.
	# One file per process also isolates module mocks: adding a file must not
	# regroup unrelated fixtures and change which API implementation they see.
	cd apps/console && find tests \( -name '*.test.ts' -o -name '*.test.tsx' \) \
		! -path 'tests/e2e/*' | sort | xargs -n $(UNIT_CONSOLE_BATCH_SIZE) bun test --smol
	bun scripts/env.ts --template --check
	bash -n scripts/link-dev-pass.sh
	bash tests/scripts/make-dev-contract.sh
	bash tests/scripts/dev-watch-contract.sh
	bash tests/scripts/db-reset-contract.sh
	bash tests/scripts/dev-infra-contract.sh
	bash tests/scripts/db-backup-contract.sh
	bash tests/scripts/ci-plan-contract.sh
	bash tests/scripts/dco-check-contract.sh
	bash tests/scripts/fake-hermes-contract.sh
	bun tests/scripts/edge-setup-release-url-contract.ts
	bun tests/scripts/console-platform-contract.ts
	bash tests/scripts/db-ownership-contract.sh
	bun tests/scripts/foreign-reads-contract.ts
	bun tests/scripts/run-writes-contract.ts
	bun tests/scripts/run-events-contract.ts
	bun tests/scripts/runtime-client-contract.ts
	bun tests/scripts/code-structure-contract.ts
	bash tests/scripts/migration-record-contract.sh
	bash tests/scripts/pro-migrations-contract.sh
	bash tests/scripts/css-backdrop-order-contract.sh
	bash tests/scripts/policies-claims-contract.sh
	bash tests/scripts/console-build-guard-contract.sh

# Solo et avec plug-ins, mêmes tests : `test-unit` une fois sans plug-in, puis
# avec les plug-ins du répertoire plugins/ (voir plugins_dir) chargés par
# OPENEDBOT_PLUGINS (chemins absolus). Ce répertoire est relié à CE checkout du cœur avant
# (`make link-core OPENEDBOT_MAIN_DIR=…`), pour que cœur et plug-ins partagent une
# seule copie de chaque module. Les tests d'or des permissions jouent dans
# les deux modes ; `apps/api/tests/pro-mode.test.ts` ne joue qu'en pro.
# Sans plugins/, le cœur ne nomme aucun chemin de plug-in et le solo n'en
# demande aucun (listes de plug-ins vides). Les cibles avec plug-ins
# (test-dual, pro-check…) exigent le checkout des plug-ins en ./plugins.
PRO_PLUGIN_ENTRIES ?= packages/pro-audit/src/index.ts packages/pro-permissions/src/index.ts packages/pro-billing/src/index.ts
pro_comma := ,
pro_empty :=
pro_space := $(pro_empty) $(pro_empty)
PRO_PLUGINS_LIST = $(subst $(pro_space),$(pro_comma),$(strip $(if $(plugins_dir),$(foreach entry,$(PRO_PLUGIN_ENTRIES),$(plugins_dir)/$(entry)))))
# Les écrans pro de la console (étape 9) : un module console par paquet pro
# (`console/index.ts`), chargé par OPENEDBOT_CONSOLE_PLUGINS (`apps/console/vite-pro-console.ts`,
# et `test-setup.ts` pour les tests). La facturation a son paquet depuis
# l'étape 8d (`pro-billing/console`) ; plus aucune amorce du cœur ici.
PRO_CONSOLE_ENTRIES ?= packages/pro-permissions/console/index.ts packages/pro-billing/console/index.ts
PRO_CONSOLE_CORE_MODULES ?=
PRO_CONSOLE_LIST = $(subst $(pro_space),$(pro_comma),$(strip $(if $(plugins_dir),$(foreach entry,$(PRO_CONSOLE_ENTRIES),$(plugins_dir)/$(entry))) $(PRO_CONSOLE_CORE_MODULES)))

test-dual: ## Unit tests twice: solo (no plug-in), then with the external plug-ins (./plugins).
	@echo "== test-dual : solo (OPENEDBOT_PLUGINS et OPENEDBOT_CONSOLE_PLUGINS vides)"
	OPENEDBOT_PLUGINS= OPENEDBOT_CONSOLE_PLUGINS= $(MAKE) test-unit
	@test -f "plugins/package.json" || { echo "test-dual : pas de plug-ins dans ./plugins (clonez ou liez le checkout des plug-ins en ./plugins)"; exit 2; }
	$(MAKE) -C plugins link-core OPENEDBOT_MAIN_DIR=$(CURDIR)
	@echo "== test-dual : pro (OPENEDBOT_PLUGINS=$(PRO_PLUGINS_LIST) OPENEDBOT_CONSOLE_PLUGINS=$(PRO_CONSOLE_LIST))"
	OPENEDBOT_PLUGINS=$(PRO_PLUGINS_LIST) OPENEDBOT_CONSOLE_PLUGINS=$(PRO_CONSOLE_LIST) $(MAKE) test-unit

# Ce qu'un lancement de la console solo télécharge, sous les budgets du premier
# chargement : chunk d'entrée et premier chargement, en gzip
# (`apps/console/scripts/bundle-budget.ts`). Build solo dans BUNDLE_BUDGET_DIR,
# jamais dans apps/console/dist, sans .env.local ni plug-ins : la CI le joue.
BUNDLE_BUDGET_DIR ?= $(or $(TMPDIR),/tmp/)openedbot-bundle-budget

bundle-budget: ## Bundle budget of the solo console (entry, first load), gzipped.
	@rm -rf "$(BUNDLE_BUDGET_DIR)" && mkdir -p "$(BUNDLE_BUDGET_DIR)"
	cd apps/console && OPENEDBOT_CONSOLE_PLUGINS= OPENEDBOT_CONSOLE_MODULE_REPORT="$(BUNDLE_BUDGET_DIR)/report.json" ./node_modules/.bin/vite build --logLevel warn --outDir "$(BUNDLE_BUDGET_DIR)/dist" --emptyOutDir
	bun apps/console/scripts/bundle-budget.ts "$(BUNDLE_BUDGET_DIR)/dist" "$(BUNDLE_BUDGET_DIR)/report.json"
	@rm -rf "$(BUNDLE_BUDGET_DIR)"

# La console solo ne contient aucun écran pro (facturation, règles de
# permission) : un build Vite sans OPENEDBOT_CONSOLE_PLUGINS, dont le rapport de modules
# (`vite-module-report.ts`) est lu par `apps/console/scripts/solo-bundle-check.ts`
# et dont le JS ne nomme aucune route `/api/pro/` (`solo-bundle-strings.ts`),
# puis deps-check (règle `console-sans-ecrans-pro`, contrat de frontière du
# cœur ouvert) et test-unit sans plug-in. `solo-check` tourne dans le dépôt
# public, sans ./plugins ; avec le checkout des plug-ins, il cherche aussi
# leurs chaînes. Le contrôle inverse (le build pro contient chaque écran pro)
# et test-dual sont `pro-check`, qui exige ./plugins. Builds dans
# SOLO_CHECK_DIR, jamais dans apps/console/dist, sans .env.local ni réseau.
SOLO_CHECK_DIR ?= $(or $(TMPDIR),/tmp/)openedbot-solo-check
# The pro screens' strings, which `solo-bundle-strings.ts` must find in the pro
# build and nowhere in the solo one (with the pro routes). Empty without ./plugins.
SOLO_CHECK_MESSAGES = $(if $(plugins_dir),$(sort $(wildcard $(plugins_dir)/packages/*/console/messages.*.ts)))
solo-check: ## Solo console without any pro screen (bundle and routes), deps-check and test-unit without plug-ins; needs no ./plugins.
	@rm -rf "$(SOLO_CHECK_DIR)" && mkdir -p "$(SOLO_CHECK_DIR)"
	@echo "== solo-check : build solo (OPENEDBOT_CONSOLE_PLUGINS vide)"
	cd apps/console && OPENEDBOT_CONSOLE_PLUGINS= OPENEDBOT_CONSOLE_MODULE_REPORT="$(SOLO_CHECK_DIR)/solo.json" ./node_modules/.bin/vite build --logLevel warn --outDir "$(SOLO_CHECK_DIR)/solo" --emptyOutDir
	bun apps/console/scripts/solo-bundle-check.ts solo "$(SOLO_CHECK_DIR)/solo.json"
	bun apps/console/scripts/solo-bundle-strings.ts solo "$(SOLO_CHECK_DIR)/solo" $(SOLO_CHECK_MESSAGES)
	@rm -rf "$(SOLO_CHECK_DIR)"
	$(MAKE) deps-check
	@echo "== solo-check : test-unit (OPENEDBOT_PLUGINS et OPENEDBOT_CONSOLE_PLUGINS vides)"
	OPENEDBOT_PLUGINS= OPENEDBOT_CONSOLE_PLUGINS= $(MAKE) test-unit

pro-check: ## [plug-ins] Contrôle pro du bundle (chaque écran pro présent) puis test-dual ; exige ./plugins.
	@test -f "plugins/package.json" || { echo "pro-check : pas de plug-ins dans ./plugins (clonez ou liez le checkout des plug-ins en ./plugins)"; exit 2; }
	$(MAKE) -C plugins link-core OPENEDBOT_MAIN_DIR=$(CURDIR)
	@rm -rf "$(SOLO_CHECK_DIR)" && mkdir -p "$(SOLO_CHECK_DIR)"
	@echo "== pro-check : build pro (OPENEDBOT_CONSOLE_PLUGINS=$(PRO_CONSOLE_LIST))"
	cd apps/console && OPENEDBOT_CONSOLE_PLUGINS=$(PRO_CONSOLE_LIST) OPENEDBOT_CONSOLE_MODULE_REPORT="$(SOLO_CHECK_DIR)/pro.json" ./node_modules/.bin/vite build --logLevel warn --outDir "$(SOLO_CHECK_DIR)/pro" --emptyOutDir
	bun apps/console/scripts/solo-bundle-check.ts pro "$(SOLO_CHECK_DIR)/pro.json"
	bun apps/console/scripts/solo-bundle-strings.ts pro "$(SOLO_CHECK_DIR)/pro" $(SOLO_CHECK_MESSAGES)
	@rm -rf "$(SOLO_CHECK_DIR)"
	$(MAKE) test-dual

# PostgreSQL RLS and import fault injection against a loopback fake Hermes.
# CI supplies PostgreSQL URLs; the import proof never starts a service.
test-integration: $(if $(INTEGRATION_DATABASE_URL),,db-up) ## Disposable PostgreSQL: migrations, RLS and imports with a local fake Hermes.
	bash tests/integration/postgres-rls.sh
	bun tests/integration/mvp-workflows.ts
	bun tests/integration/mvp-recovery.ts
	bun tests/integration/native-refresh-recovery.ts
	bun tests/integration/account-closure.ts
	bun tests/integration/runtime-direct-access.ts
	bun tests/integration/profile-imports-runner.ts
	bun tests/integration/worker-tenant-scope.ts
	bun tests/integration/worker-queue-probe.ts
	bun tests/integration/thread-history.ts
	bun tests/integration/runtime-link-alerts.ts
	bun tests/integration/alert-channels.ts
	bun tests/integration/dm-without-workflow.ts
	bun tests/integration/orphan-unknown-runs.ts
	bun tests/integration/e2e-cleanup-workflows.ts
	bun tests/integration/run-event-sequences.ts
	bun tests/integration/tool-error-codes.ts
	bun tests/integration/e2e-runtime-guard.ts
	bun tests/integration/run-transitions.ts
	bun tests/integration/workflow-admission-grace.ts
	bun tests/integration/execution-commands.ts
	bun tests/integration/permission-policy-preflight.ts
	bun tests/integration/runtime-change-notify.ts
	bun tests/integration/link-vitality.ts
	bun tests/integration/open-signup.ts
	bun tests/integration/waitlist-erasure.ts
	bun tests/integration/single-workspace-accounts.ts
	bun tests/integration/member-invitations.ts
	bun tests/integration/organization-permission-policy.ts
	bun tests/integration/tool-policies.ts
	bun tests/integration/permission-grants.ts
	bun tests/integration/decision-trace.ts
	bun tests/integration/named-coordination.ts
	bun tests/integration/fast-path-stream.ts
	bun tests/integration/routine-tool.ts
	bun tests/integration/routine-tool-install.ts
	bun tests/integration/unattended-gates.ts
	bun tests/integration/bot-settings-tool.ts
	bun tests/integration/run-identity-replay.ts
	OPENEDBOT_TEST_118_CLEAN_EOF=1 bun tests/integration/run-identity-replay.ts
	OPENEDBOT_TEST_118_STATUS_RECOVERY=1 bun tests/integration/run-identity-replay.ts
	OPENEDBOT_TEST_118_STATUS_RECOVERY=failed bun tests/integration/run-identity-replay.ts
	bun tests/integration/run-crash-replay.ts
	OPENEDBOT_TEST_115_STATUS_RECOVERY=1 bun tests/integration/run-crash-replay.ts
	bun tests/integration/busy-followup.ts
	bun tests/integration/steer-lock-order.ts
	bun tests/integration/worker-queue-lease.ts
	bun tests/integration/runtime-link-generation.ts
	bun tests/integration/runtime-link-device-key.ts
	bun tests/integration/runtime-link-diagnostics.ts
	bun tests/integration/runtime-read-snapshots-store.ts
	bun tests/integration/apns-push.ts
	bun tests/integration/text-array-binds.ts
	bun tests/integration/provider-fallback-stream.ts
	bun tests/integration/run-stop-cause.ts
	# S7 : un run suivi de bout en bout par un seul trace-id (API, worker, passerelle, connecteur Go réel, Hermes) ; exige go.
	bun tests/integration/run-trace-correlation.ts
	# Derniers : ils exigent SQL.listen (Bun >= 1.4, le packageManager épinglé) et disent pourquoi s'il manque.
	bun tests/integration/worker-queue-notifications.ts
	bun tests/integration/realtime-listen.ts

# Le connecteur PUBLIÉ (tag edge-setup/vX.Y.Z, présent localement) contre ce
# serveur : le run aboutit, le worker et la passerelle journalisent la trace,
# le vieux connecteur écarte `traceparent` sans rien casser.
# Pas de défaut : l'historique est reparti d'un seul commit le 2026-11-12 et
# tous les tags du nouvel historique (edge-setup/v1.5.7 et suivants) propagent
# déjà la trace, ce que la preuve refuserait. Il faut un tag d'avant la trace,
# récupéré de la sauvegarde de l'ancien historique (ex. edge-setup/v1.5.0).
TRACE_LEGACY_REF ?=
test-trace-legacy: $(if $(INTEGRATION_DATABASE_URL),,db-up) ## S7 proof with a connector released before the trace: TRACE_LEGACY_REF=<backup tag, e.g. edge-setup/v1.5.0>; requires go and the tag.
	@[ -n "$(TRACE_LEGACY_REF)" ] || { echo "TRACE_LEGACY_REF=<tag edge-setup d'avant la trace> est requis (ancien historique, sauvegarde) : les tags du nouvel historique propagent déjà traceparent" >&2; exit 2; }
	OPENEDBOT_TRACE_E2E_LEGACY_REF=$(TRACE_LEGACY_REF) bun tests/integration/run-trace-correlation.ts

test: test-unit test-integration ## Unit and integration tests.

check: env-audit typecheck deps-check test build-cloud ## Full guard: environment, code, tests and cloud builds.

# ─── Desktop Tauri ───────────────────────────────
# Le shell Rust (`apps/desktop-tauri/src-tauri`) embarque la console solo en
# mode desktop. Rien n'est publié d'ici : le build signé reste dans
# `apps/desktop-tauri/release/<version>/`, le flux de mise à jour de test est
# servi en boucle locale. Clés : Developer ID dans le trousseau, notarisation
# et clé de mise à jour hors du dépôt (`scripts/build-mac.ts`) ; la moitié
# publique de la clé de mise à jour est `apps/desktop-tauri/updater.pub`.
# TAURI_IDENTITY=production (D3, D6) : l'app publiée (app.openedbot.desktop,
# « openedbot », openedbot://) ; preview par défaut.
# Une release : desktop-tauri-mac, puis desktop-tauri-linux pour x86_64 et
# aarch64, tous en TAURI_IDENTITY=production, puis desktop-tauri-release.
.PHONY: desktop-tauri-bindings desktop-tauri-check desktop-tauri-mac desktop-tauri-release desktop-tauri-prune desktop-tauri-feed desktop-tauri-publish
DESKTOP_TAURI_DIR := apps/desktop-tauri
TAURI_VERSION ?=
TAURI_SIGN ?= developer-id
TAURI_POPUP ?=
TAURI_IDENTITY ?= preview
TAURI_NOTES ?=

# `make desktop` : l'app desktop « openedbot dev » seule, en hot reload natif
# (`tauri dev` : console Vite sur DESKTOP_DEV_PORT, shell Rust recompilé à
# chaque changement), contre l'API locale lancée par `make dev` dans un autre
# terminal. `make dev` ne l'inclut plus, sauf avec DESKTOP=1. Détails dans
# `apps/desktop-tauri/scripts/dev.ts`.
.PHONY: desktop desktop-dev
desktop: ## [DESKTOP] The desktop app "openedbot dev" alone, with native hot reload (tauri dev, console :1422) against the local API (make dev first in another terminal; make dev no longer includes it without DESKTOP=1).
	@$(REQUIRE_API)
	$(LOAD_ENV_OPT) bun run --cwd $(DESKTOP_TAURI_DIR) --silent dev

desktop-dev: desktop ## [DESKTOP] Former name of make desktop.

desktop-tauri-bindings: ## [DESKTOP] Regenerates the native bridge contract (contracts/native-bridge) from the Rust commands.
	cd $(DESKTOP_TAURI_DIR)/src-tauri && cargo run --quiet --example export-bindings -- ../../../contracts/native-bridge/src/bindings.ts

desktop-tauri-check: ## [DESKTOP] cargo test (IPC refusals, single-flight refresh, vault, popup, bindings up to date) and cargo clippy -D warnings.
	cd $(DESKTOP_TAURI_DIR)/src-tauri && cargo test --quiet && cargo clippy --all-targets --quiet -- -D warnings

desktop-tauri-mac: ## [DESKTOP] macOS build signed with Developer ID, notarized, stapled + signed update artifact: TAURI_VERSION=X.Y.Z[-test] [TAURI_IDENTITY=production] [TAURI_SIGN=adhoc] [TAURI_POPUP=…/OpenedbotPopup.app].
	@[ -n "$(TAURI_VERSION)" ] || { echo "TAURI_VERSION=X.Y.Z est requis"; exit 1; }
	bun $(DESKTOP_TAURI_DIR)/scripts/build-mac.ts --version "$(TAURI_VERSION)" --sign "$(TAURI_SIGN)" --identity "$(TAURI_IDENTITY)" $(if $(TAURI_POPUP),--popup "$(TAURI_POPUP)")

desktop-tauri-release: ## [DESKTOP] Gathers the macOS + Linux release (production builds) to publish on R2: desktop/vX.Y.Z/ (SHA256SUMS, verified signatures), beta/stable manifests of every platform. Publishes nothing: TAURI_VERSION=X.Y.Z [TAURI_NOTES=notes.md].
	@[ -n "$(TAURI_VERSION)" ] || { echo "TAURI_VERSION=X.Y.Z est requis"; exit 1; }
	bun $(DESKTOP_TAURI_DIR)/scripts/release.ts --version "$(TAURI_VERSION)" $(if $(TAURI_NOTES),--notes "$(TAURI_NOTES)")

# Après une release complète (stable promu) : seules les deux dernières
# publications restent sur R2, plus celles que les manifestes servent.
TAURI_PRUNE_APPLY ?= 0
desktop-tauri-prune: ## [DESKTOP] desktop/ versions on R2 beyond the two latest published (upload date of SHA256SUMS), except the versions served by stable/beta: dry run by default, TAURI_PRUNE_APPLY=1 to delete; CLOUDFLARE_API_TOKEN and CF_ACCOUNT_ID required.
	bun $(DESKTOP_TAURI_DIR)/scripts/prune-r2.ts $(if $(filter 1,$(TAURI_PRUNE_APPLY)),--apply)

desktop-tauri-feed: ## [DESKTOP] Serves the local update feed on http://127.0.0.1:8799/latest.json.
	bun $(DESKTOP_TAURI_DIR)/scripts/update-feed.ts serve --port 8799

desktop-tauri-publish: ## [DESKTOP] Publishes a built version to the local feed: TAURI_VERSION=X.Y.Z.
	@[ -n "$(TAURI_VERSION)" ] || { echo "TAURI_VERSION=X.Y.Z est requis"; exit 1; }
	bun $(DESKTOP_TAURI_DIR)/scripts/update-feed.ts publish --version "$(TAURI_VERSION)" --port 8799

# ─── Desktop Tauri Linux ───────────────────────────────
# Tout passe par l'image `apps/desktop-tauri/linux/Dockerfile` (Ubuntu 24.04,
# WebKitGTK 4.1) : x86_64 émulé sur un Mac arm64 (OrbStack), aarch64 natif.
# Les paquets restent dans `apps/desktop-tauri/dist-linux/<version>/<arch>/`
# (ignoré), les preuves du parcours dans `dist-linux/e2e/`. Rien n'est publié.
# Le parcours (e2e, update) vise la preview.
.PHONY: desktop-tauri-linux desktop-tauri-linux-check desktop-tauri-linux-e2e desktop-tauri-linux-update
TAURI_LINUX_ARCH ?= x86_64
TAURI_FROM ?=
TAURI_TO ?=

desktop-tauri-linux: ## [DESKTOP] Linux deb + AppImage packages (+ signed update artifact) built in Docker: TAURI_VERSION=X.Y.Z [TAURI_LINUX_ARCH=x86_64|aarch64] [TAURI_IDENTITY=production].
	@[ -n "$(TAURI_VERSION)" ] || { echo "TAURI_VERSION=X.Y.Z est requis"; exit 1; }
	bun $(DESKTOP_TAURI_DIR)/scripts/build-linux.ts --docker --version "$(TAURI_VERSION)" --arch "$(TAURI_LINUX_ARCH)" --identity "$(TAURI_IDENTITY)"

desktop-tauri-linux-check: ## [DESKTOP] In Docker, like the CI: cargo test, Secret Service vault, cargo clippy -D warnings (Linux).
	bun $(DESKTOP_TAURI_DIR)/scripts/linux-docker.ts check --arch "$(TAURI_LINUX_ARCH)"

desktop-tauri-linux-e2e: ## [DESKTOP] Real journey under Xvfb against the local API (make dev): sign-in, threads, streaming, vault, restarts: TAURI_VERSION=X.Y.Z.
	@[ -n "$(TAURI_VERSION)" ] || { echo "TAURI_VERSION=X.Y.Z est requis"; exit 1; }
	bun $(DESKTOP_TAURI_DIR)/scripts/linux-docker.ts e2e --version "$(TAURI_VERSION)" --arch "$(TAURI_LINUX_ARCH)"

desktop-tauri-linux-update: ## [DESKTOP] The AppImage updates itself through the local feed then refuses a foreign signature: TAURI_FROM=X.Y.Z TAURI_TO=X.Y.Z-test.
	@[ -n "$(TAURI_FROM)" ] && [ -n "$(TAURI_TO)" ] || { echo "TAURI_FROM et TAURI_TO sont requis"; exit 1; }
	bun $(DESKTOP_TAURI_DIR)/scripts/linux-docker.ts update --from "$(TAURI_FROM)" --to "$(TAURI_TO)" --arch "$(TAURI_LINUX_ARCH)"

# ─── Connector contract ──────────────────────────────────────────────────────
# Le fil entre edge-setup (Go, chez le client) et openedbot (TS, dans le cloud) a
# deux implémentations et des fixtures en double : trames, journal de
# création, manifeste de l'allowlist. Cette cible est la seule porte qui voit
# les deux moitiés à la fois ; les déploiements et la release sur tag la
# jouent avant de livrer quoi que ce soit.
.PHONY: contract-check

# edge-setup vit dans edge-setup/ de ce dépôt (monorepo), plus à côté de
# celui-ci (EDGE_SETUP_DIR pour un autre chemin). Absent, le contrat échoue :
# il ne se joue jamais sur une seule moitié.
EDGE_SETUP_DIR ?= $(CURDIR)/edge-setup
CONTRACT_GO  := $(EDGE_SETUP_DIR)
CONTRACT_TS  := platform/hermes
CONTRACT_COPIES := \
	$(CONTRACT_GO)/test/golden/relay-frames/vectors.json=$(CONTRACT_TS)/tests/fixtures/relay-frames.vectors.json \
	$(CONTRACT_GO)/test/golden/relay-allowlist/allowlist.json=$(CONTRACT_TS)/tests/fixtures/relay-allowlist.json \
	$(CONTRACT_GO)/test/golden/forbidden-toolsets/forbidden-toolsets.json=modules/runtimes/tests/fixtures/forbidden-toolsets.json \
	$(CONTRACT_GO)/internal/connector/testdata/creation-audit-v2.bin=$(CONTRACT_TS)/tests/fixtures/creation-audit/creation-audit-v2.bin \
	$(CONTRACT_GO)/internal/connector/testdata/creation-audit-v2.json=$(CONTRACT_TS)/tests/fixtures/creation-audit/creation-audit-v2.json \
	$(CONTRACT_GO)/internal/connector/testdata/creation-audit-v2.key.txt=$(CONTRACT_TS)/tests/fixtures/creation-audit/creation-audit-v2.key.txt

contract-check: ## [contract] Identical copies of the wire fixtures, then the Go and TS tests of the connector (EDGE_SETUP_DIR, default edge-setup/).
	@if [ ! -f "$(CONTRACT_GO)/go.mod" ]; then \
		printf '$(C_ERR)[make]$(C_RESET) edge-setup introuvable : %s (edge-setup/ de ce dépôt, ou EDGE_SETUP_DIR=...).\n' "$(CONTRACT_GO)" >&2; exit 2; \
	fi
	@status=0; for pair in $(CONTRACT_COPIES); do \
		go_copy="$${pair%%=*}"; ts_copy="$${pair#*=}"; \
		if ! cmp -s "$$go_copy" "$$ts_copy"; then \
			printf '$(C_ERR)[make]$(C_RESET) %s et %s divergent.\n' "$$go_copy" "$$ts_copy" >&2; status=1; \
		fi; \
	done; \
	if [ "$$status" -ne 0 ]; then exit 1; fi; \
	printf '$(C_OK)[make]$(C_RESET) Fixtures du fil identiques des deux côtés.\n'
	cd $(CONTRACT_GO) && go test -count=1 ./internal/connector/... ./internal/pins/...
	EDGE_SETUP_DIR="$(abspath $(CONTRACT_GO))" bun test $(CONTRACT_TS)/tests/transport $(CONTRACT_TS)/tests/creation-audit modules/runtimes/tests/runtime-contract.test.ts
	@printf '$(C_OK)[make]$(C_RESET) Contrat connecteur tenu des deux côtés.\n'

# ─── E2E and load ────────────────────────────────────────────────────────────
.PHONY: e2e-api e2e-bot e2e-bot-p0 e2e-bot-p1 e2e-bot-keep e2e-bot-bench e2e-console e2e-fresh-setup e2e-onboarding e2e-hermes
.PHONY: e2e-link e2e-link-load e2e-link-separation e2e-link-continuity e2e-push email-preview e2e-email load

e2e-api: ## Cloud HTTP journeys; requires the local stack to be running (make dev).
	@$(REQUIRE_API)
	$(LOAD_ENV_OPT) bun tests/e2e/api-cloud.ts

e2e-bot: ## E2E bots on the linked runtime (SCENARIOS=lifecycle|p0|p1|acceptance|all, ARGS=...); strict P0/P1 with E2E_RUNTIME_ID; HTML report in tmp/e2e-bot/.
	@$(REQUIRE_API)
	@printf '$(C_WARN)[make]$(C_RESET) Inférence réelle : bots jetables, purgés et nettoyage hôte vérifié avant la fin.\n'
	$(LOAD_ENV_OPT) E2E_ALLOW_REAL_RUNS=1 bun tests/e2e/bot/run.ts $(or $(SCENARIOS),lifecycle) $(ARGS)

e2e-bot-p0: ## P0 proofs: files, browser, concurrency, interruptions and isolation; requires E2E_RUNTIME_ID.
	$(MAKE) e2e-bot SCENARIOS=p0

e2e-bot-p1: ## P1 proofs: memory, skills/MCP, routines, attachments and coordination; requires E2E_RUNTIME_ID.
	$(MAKE) e2e-bot SCENARIOS=p1

e2e-bot-keep: ## Same as the lifecycle scenario, but LEAVES the bot alive for inspection in the console (purge it yourself).
	@$(REQUIRE_API)
	@printf '$(C_WARN)[make]$(C_RESET) le bot créé NE sera PAS purgé : la base ne sera pas rendue telle quelle.\n'
	$(LOAD_ENV_OPT) E2E_ALLOW_REAL_RUNS=1 bun tests/e2e/bot/run.ts lifecycle --keep $(ARGS)

e2e-bot-bench: ## Bot bench: creation to first question (SAMPLES=3) and turns of a ready bot (MESSAGES=5), p50/p95/max in the HTML report.
	@$(REQUIRE_API)
	@printf '$(C_WARN)[make]$(C_RESET) Inférence réelle : bots jetables, purgés et nettoyage hôte vérifié avant la fin.\n'
	$(LOAD_ENV_OPT) E2E_ALLOW_REAL_RUNS=1 bun tests/e2e/bot/run.ts greeting fast-path --samples $(or $(SAMPLES),3) --messages $(or $(MESSAGES),5) --label bench $(ARGS)

e2e-console: ## Every deterministic console journey, without a server or a provider key.
	cd apps/console && find tests/e2e \( -name '*.test.ts' -o -name '*.test.tsx' \) | sort | xargs -n 1 bun test --smol

e2e-fresh-setup: ## Deterministic UI journey without an agent, a key or an SSH channel.
	cd apps/console && bun test tests/e2e/fresh-setup.e2e.test.tsx

e2e-onboarding: ## Checks the shadcn provider/model order and the inference gates.
	cd apps/console && bun test tests/e2e/onboarding-runtime.e2e.test.tsx

e2e-hermes: ## Non-destructive live canary against DEV_HERMES_URL (HTTPS, or an origin declared in HERMES_ALLOW_INSECURE_ORIGINS).
	$(LOAD_ENV) bun tests/e2e/hermes-contract.ts

e2e-link: ## Enrolls a runtime through the connector link against the local API (make dev) and an in-process fake Hermes.
	@$(REQUIRE_API)
	$(LOAD_ENV_OPT) bun tests/e2e/link-connector.ts

e2e-link-load: ## k6 E2E of the real API → VPS link: health, bounded load, log and report; no model called.
	@printf '$(C_SECTION)[make]$(C_RESET) E2E k6 sur le runtime réellement connecté.\n'
	@$(LOAD_ENV_OPT) bun tests/e2e/connector-live-k6.ts

e2e-link-separation: ## Checks the isolated gateway, the flows and the cuts on throwaway test processes.
	@printf '$(C_SECTION)[make]$(C_RESET) Régression transport Go/TS avec redémarrages API simulés.\n'
	@OPENEDBOT_LINK_GATEWAY_E2E=1 bun test apps/api/tests/runtime-link-separation.e2e.test.ts

e2e-link-continuity: ## Opt-in real acceptance run: explicit provider, bot lifecycle and link observation.
	@printf '$(C_WARN)[make]$(C_RESET) Inférence réelle : E2E_ALLOW_REAL_RUNS=1 et runtime/modèle explicites requis.\n'
	@$(LOAD_ENV_OPT) bun tests/e2e/runtime-link-live-continuity.ts

e2e-push: ## Web Push against a simulated server (never FCM/Mozilla); requires the local stack to be running, PUSH_VAPID_* and PUSH_ALLOW_LOOPBACK_ENDPOINTS=1.
	@$(REQUIRE_API)
	$(LOAD_ENV_OPT) bun tests/e2e/push.ts

email-preview: ## Renders every e-mail template into tmp/email-preview/ (HTML + text, fr and en); sends nothing.
	rm -rf tmp/email-preview
	bun scripts/email-preview.ts

e2e-email: ## Transactional SMTP e-mail to Mailpit (:1025/:8025); stops cleanly when it is absent.
	$(LOAD_ENV_OPT) bun tests/e2e/email.ts

load: ## Local load bench (SSE, looping conversations, streaming fake Hermes): LOAD_SESSIONS=50|100|200|500, LOAD_DURATION_SECONDS, LOAD_CONVERSATIONS; report in tmp/load/latest.
	bash tests/load/run.sh

# ─── Build ───────────────────────────────────────────────────────────────────
# Les artefacts sont construits SUR LE POSTE (make build-*). La preuve locale
# combine typecheck, tests unitaires, contrats et, pour les changements de
# runtime, l'application locale reliée à un runtime distant (make link-dev-up).
# Le déploiement lui-même n'est pas dans ce dépôt.
.PHONY: build build-console build-api build-alerting build-cloud deploy

DEPLOY_APPS_ACTIVE ?= console
DEPLOY_APPS := $(if $(APP),$(APP),$(DEPLOY_APPS_ACTIVE))
comma := ,
DEPLOY_APP_LIST := $(subst $(comma), ,$(DEPLOY_APPS))

# `make build` livre les artefacts du rôle alpha : même garde qu'un déploiement
# dès que la console en fait partie (une console solo par oubli de
# OPENEDBOT_CONSOLE_PLUGINS est refusée, OPENEDBOT_CONSOLE_MODE=solo l'assume). La garde passe
# AVANT tout build, y compris en -j : les builds sont relancés après elle.
build: $(if $(filter console,$(DEPLOY_APP_LIST)),prod-console-guard) ## [deploy] Builds the artifacts of the active apps (or APP=console,api).
	@$(MAKE) --no-print-directory $(addprefix build-,$(DEPLOY_APP_LIST))

build-console: ## [deploy] Builds the web console (apps/console/dist), without deploying anything.
	$(LOAD_ENV_OPT) bun run --filter console build


build-api: ## Builds the API and the worker.
	mkdir -p dist/bin
	bun build apps/api/src/index.ts --target=bun --outfile=dist/bin/openedbot-api
	bun build apps/worker/src/index.ts --target=bun --outfile=dist/bin/openedbot-worker

build-alerting: ## Builds the internal alerting probe.
	mkdir -p dist/bin
	bun build apps/api/src/alerting/index.ts --target=bun --outfile=dist/bin/openedbot-alerting

build-cloud: build-api build-alerting build-console ## Builds the deployable services and SPA.

deploy: ## Refuses: deployment is not in this repository; make build builds the artifacts.
	@printf '$(C_ERR)[make]$(C_RESET) Le déploiement n'"'"'est pas dans ce dépôt : make build construit les artefacts.\n' >&2; exit 2

# ─── Prod: build guard and production link ───────────────────────────────────
.PHONY: prod-console-guard link-prod

# La console hébergée porte les écrans des plug-ins (étape 9) : sans OPENEDBOT_CONSOLE_PLUGINS,
# `build-console` sortirait une console solo, sans facturation ni
# règles de permission. Refus avant tout déploiement et avant tout
# build (`make build`, rôle alpha) ; OPENEDBOT_CONSOLE_MODE=solo pour une console solo
# assumée. Contrat : tests/scripts/console-build-guard-contract.sh.
prod-console-guard:
	@if [ -z "$(OPENEDBOT_CONSOLE_PLUGINS)" ] && [ "$(OPENEDBOT_CONSOLE_MODE)" != "solo" ]; then printf '$(C_ERR)[make]$(C_RESET) OPENEDBOT_CONSOLE_PLUGINS vide : la console hébergée serait solo. make $(or $(MAKECMDGOALS),build) OPENEDBOT_CONSOLE_PLUGINS=$(PRO_CONSOLE_LIST) (plug-ins reliés : make -C plugins link-core OPENEDBOT_MAIN_DIR=$(CURDIR)), ou OPENEDBOT_CONSOLE_MODE=solo.\n' >&2; exit 2; fi

# L'origine de production, celle que la console affiche dans sa commande
# d'appairage. `link-prod` en est le pendant `make` : la bascule inverse de
# `link-dev-up`, en une commande entière plutôt qu'un copier-coller vers le VPS.
# Le ticket n'est ni ici ni dans argv : `edge-setup` le demande à son invite
# masquée sur le VPS, d'où le `ssh -t`.
# Origine du lien de la prod (RUNTIME_LINK_PUBLIC_URL du VPS) : un nouveau lien
# vise toujours celle-ci ; openedbot.app (API_PUBLIC_URL) reste acceptée.
OPENEDBOT_PUBLIC_URL ?= https://link.openedbot.app
# La console où l'opérateur ouvre le ticket (API_PUBLIC_URL du VPS).
OPENEDBOT_CONSOLE_URL ?= https://openedbot.app

link-prod: ## [OPS] Switches the VPS to production; the ticket is asked at the VPS's hidden prompt (HOST=user@vps).
	@set -eo pipefail; \
	if [ -z "$(HOST)" ]; then \
		printf '$(C_ERR)[make]$(C_RESET) HOST est requis : make link-prod HOST=user@vps.\n' >&2; exit 2; \
	fi; \
	case "$(OPENEDBOT_PUBLIC_URL)" in \
		https://*) ;; \
		*) printf '$(C_ERR)[make]$(C_RESET) OPENEDBOT_PUBLIC_URL doit être une origine https.\n' >&2; exit 2 ;; \
	esac; \
	printf '$(C_OK)[make]$(C_RESET) Ouvrez un ticket dans %s, onglet Runtimes, « Ajouter un runtime ».\n' "$(OPENEDBOT_CONSOLE_URL)"; \
	printf '$(C_OK)[make]$(C_RESET) Collez-le à l’invite masquée ci-dessous ; il ne passe ni par argv ni par l’historique.\n'; \
	ssh -t "$(HOST)" sudo edge-setup link --openedbot "$(OPENEDBOT_PUBLIC_URL)" --yes

# ─── Cleanup ─────────────────────────────────────────────────────────────────
.PHONY: clean

clean: ## Removes generated artifacts only; never .data nor PostgreSQL.
	rm -rf dist apps/api/dist apps/console/dist

# ─── Private fragments ───────────────────────────────────────────────────────
# Seul point d'extension : les fragments make du checkout des plug-ins
# (plugins/make/*.mk, ignoré par git). Absents, rien n'est inclus.
-include $(wildcard $(CURDIR)/plugins/make/*.mk)
