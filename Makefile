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
# worker, console, backoffice, Makefile et scripts y puisent tous
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

DEV_COMMAND ?= bun run --filter api --filter console --filter worker --parallel --no-orphans --elide-lines=0 dev
DEV_API_COMMAND ?= bun run --cwd apps/api --silent dev
DEV_CONSOLE_COMMAND ?= bun run --cwd apps/console --silent dev
DEV_WORKER_COMMAND ?= bun run --cwd apps/worker --silent dev

# Plug-ins externes : par convention le répertoire plugins/ à la racine de ce
# checkout, ignoré par git (clone ou lien symbolique du checkout des plug-ins :
# `ln -s <checkout des plug-ins> plugins`). Détecté s'il existe ; absent, le
# cœur tourne en solo et ne nomme aucun chemin de plug-in.
plugins_dir := $(if $(wildcard $(CURDIR)/plugins/.),$(CURDIR)/plugins)
# Le backoffice staff est un plug-in externe : plugins/admin, ou ADMIN_DIR directement.
ADMIN_DIR ?= $(if $(plugins_dir),$(plugins_dir)/admin)
DEV_ADMIN_COMMAND ?= bun run --cwd $(ADMIN_DIR) --silent dev
REQUIRE_ADMIN = if [ ! -f "$(ADMIN_DIR)/package.json" ]; then printf '$(C_ERR)[make]$(C_RESET) backoffice introuvable : %s (checkout des plug-ins en ./plugins, ou ADMIN_DIR=...).\n' "$(ADMIN_DIR)" >&2; exit 2; fi

# L'app desktop (coque Electron autour de la console) vit hors des workspaces
# bun de la racine : son propre bun.lock, ses propres node_modules, son propre
# Makefile (packaging, journal, design lab : `make -C apps/desktop help`).
DESKTOP_DIR := apps/desktop
DESKTOP_DEPS := $(DESKTOP_DIR)/node_modules/.make-installed
# La console que vise `make desktop` : celle de `make dev` (WEB_APP_URL).
DESKTOP_CONSOLE_URL ?= $(or $(call env_file_value,WEB_APP_URL),http://localhost:1420)

# ─── Couleurs ────────────────────────────────────────────────────────────────
# Définies une fois, réutilisées par les recettes qui parlent à l'utilisateur.
# `NO_COLOR` les vide, comme le fait déjà `help`.
ifeq ($(NO_COLOR),)
C_SECTION := \033[1;33m
C_TARGET  := \033[36m
C_OK      := \033[32m
C_WARN    := \033[33m
C_ERR     := \033[31m
C_RESET   := \033[0m
# Préfixes des processus de `make dev` (API / CONSOLE / WORKER / autre).
C_DEV_API     := \033[1;35m
C_DEV_CONSOLE := \033[1;36m
C_DEV_WORKER  := \033[1;32m
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
C_DEV_OTHER   :=
endif

# ─── Aide ────────────────────────────────────────────────────────────────────
.PHONY: help help-all

# Les cibles du quotidien, par mode ; toutes les autres restent dans help-all.
HELP_DEV     := setup dev desktop stop link-dev-up link-dev-status link-dev-down db-migrate db-reset-keep-users
# Les fragments privés (plugins/make/*.mk, en fin de fichier) y ajoutent leurs cibles.
HELP_PREPROD :=
HELP_PROD    := link-prod
HELP_CHECK   := typecheck test-unit test-integration check
HELP_AWK = awk -v S="$(C_SECTION)" -v T="$(C_TARGET)" -v R="$(C_RESET)" \
	-v dev="$(HELP_DEV)" -v preprod="$(HELP_PREPROD)" -v prod="$(HELP_PROD)" -v check="$(HELP_CHECK)" \
	-f scripts/make-help.awk

help: ## Les commandes du quotidien, par mode.
	@$(HELP_AWK) $(MAKEFILE_LIST)

help-all: ## Toutes les commandes documentées, par section.
	@$(HELP_AWK) -v all=1 $(MAKEFILE_LIST)

# ─── Dev : installation du poste ─────────────────────────────────────────────
.PHONY: setup env-check env-audit env-prune env-template env-where env-prod-list

setup: ## Prépare entièrement le développement local (env, dépendances, PostgreSQL et données).
	ENV_FILE="$(ENV_FILE)" OPENEDBOT_DEV_PROFILE="$(MODE)" bash scripts/setup.sh

env-check: ## Valide strictement .env.local.
	ENV_FILE="$(ENV_FILE)" bun scripts/env.ts --check

env-audit: ## Vérifie les templates et affiche uniquement les noms superflus de .env.local.
	ENV_FILE="$(ENV_FILE)" bun scripts/env.ts --audit

env-prune: ## Retire de .env.local les variables hors-dev uniquement lorsqu'elles sont vides.
	ENV_FILE="$(ENV_FILE)" bun scripts/env.ts --audit --apply

env-template: ## Régénère .env.example depuis platform/config/src/env-schema.ts.
	bun scripts/env.ts --template --write

env-where: ## Où une variable est déclarée et quel fichier doit la porter (NAME=API_PORT ; sans NAME, tout le schéma).
	@ENV_FILE="$(ENV_FILE)" bun scripts/env.ts --where $(NAME)

env-prod-list: ## Imprime le modèle de production (aucun fichier de prod n'est versionné ; valeurs au gestionnaire de secrets).
	@bun scripts/env.ts --template --print-production

# ─── Dev : base et services partagés ─────────────────────────────────────────
.PHONY: db-up infra-up mailpit-up fake-hermes fake-apns db-migrate db-seed db-reset db-reset-keep-users runtime-token-rotate

db-up: ## [DB] Vérifie le PostgreSQL partagé (dev-infra, redémarré s’il est arrêté, jamais créé ici) ; jamais Hermes.
	$(LOAD_ENV_OPT) bash scripts/db.sh --up

# Alias historique de db-up (scripts/setup.sh, scripts/db.sh) : hors de l'aide.
infra-up:
	$(LOAD_ENV_OPT) bash scripts/db.sh --up

mailpit-up: ## [INFRA] Vérifie le Mailpit partagé (dev-infra) : SMTP de développement sur :1025, messages sur :8025.
	$(LOAD_ENV_OPT) bash scripts/mailpit.sh

fake-hermes: ## [FAKE] Sert le faux gateway Hermes sur 127.0.0.1:18642 au premier plan (profil fake).
	$(LOAD_ENV_OPT) FAKE_HERMES_TOKEN="$${DEV_HERMES_TOKEN:-}" bun tests/fake-hermes/server.ts

fake-apns: ## [FAKE] Sert le faux APNs HTTP/2 (h2c) sur 127.0.0.1:18793 au premier plan ; « bun tests/fake-apns/server.ts --dev-key » imprime les APNS_* à poser.
	bun tests/fake-apns/server.ts

db-migrate: ## [DB] Applique les migrations; exige une infrastructure déjà démarrée.
	$(LOAD_ENV_OPT) bash scripts/db.sh --migrate

db-seed: db-migrate env-check ## Crée le compte, l’organisation, l’abonnement et Hermes de dev.
	$(LOAD_ENV) ENV_FILE="$(abspath $(ENV_FILE))" OPENEDBOT_DEV_PROFILE="$(MODE)" bun run --filter api seed

# env-check runs before the database is dropped: an invalid .env.local must
# fail while the data is still there. The reset is a drop/create of the single
# openedbot database inside the shared dev-infra container (db-up only
# proves it is reachable); no compose project, container or volume is removed.
db-reset: env-check ## [DB] Repart d’une base openedbot vierge (drop/create dans le PostgreSQL partagé) ; exige CONFIRM=yes.
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
# memberships, sessions, staff_*, subscriptions) reste, donc la session
# ouverte dans la console survit.
db-reset-keep-users: env-check ## [DB] Vide les données applicatives locales en gardant la session utilisateur (rejoue l’accueil) ; exige CONFIRM=yes.
ifneq ($(CONFIRM),yes)
	$(error db-reset-keep-users détruit les données applicatives locales (bots, fils, runs, runtimes...). La partie utilisateur est conservée. Relancez avec CONFIRM=yes pour confirmer)
endif
	$(LOAD_ENV_OPT) bash scripts/db.sh --up
	$(LOAD_ENV_OPT) OPENEDBOT_DEV_RESET_CONFIRM=yes bun apps/api/scripts/dev-reset-data.ts
	@printf '$(C_OK)[make]$(C_RESET) Données applicatives vidées ; vous êtes toujours connecté, l’accueil se rejoue.\n'

runtime-token-rotate: db-migrate env-check ## Ré-encrypte atomiquement les tokens avec la clé courante.
	$(LOAD_ENV) bun apps/api/scripts/rotate-runtime-token-key.ts

# ─── Dev : lancer les apps ───────────────────────────────────────────────────
.PHONY: dev dev-api dev-console dev-worker dev-admin desktop preview-console stop

dev: env-check ## [API + CONSOLE + WORKER] Valide .env.local puis lance les trois apps; ni infra, ni migration. MODE=fake|bundled|external force le profil.
	@set -eo pipefail; $(LOAD_ENV) \
	format_dev_logs() { \
		local line label color payload; \
		while IFS= read -r line || [[ -n "$$line" ]]; do \
			case "$$line" in \
				api:*" | "*) label="API"; color="$(C_DEV_API)"; payload="$${line#*| }" ;; \
				console:*" | "*) label="CONSOLE"; color="$(C_DEV_CONSOLE)"; payload="$${line#*| }" ;; \
				worker:*" | "*) label="WORKER"; color="$(C_DEV_WORKER)"; payload="$${line#*| }" ;; \
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

dev-api: env-check ## [API] Lance uniquement l’API; infrastructure déjà prête.
	$(LOAD_ENV) $(DEV_API_COMMAND)

dev-console: ## [CONSOLE] Lance uniquement Vite sur :1420.
	$(LOAD_ENV_OPT) $(DEV_CONSOLE_COMMAND)

dev-worker: env-check ## [WORKER] Traite les runs/workflows; API et infrastructure à part.
	$(LOAD_ENV) $(DEV_WORKER_COMMAND)

dev-admin: ## [ADMIN] Lance le backoffice staff (ADMIN_DIR, plugins/admin, plug-in externe) sur :1421.
	@$(REQUIRE_ADMIN)
	$(LOAD_ENV_OPT) $(DEV_ADMIN_COMMAND)

# Les dépendances de l'app desktop, réinstallées dès que son package.json ou
# son bun.lock bouge (le témoin est dans node_modules : un rm -rf le relance).
$(DESKTOP_DEPS): $(DESKTOP_DIR)/package.json $(DESKTOP_DIR)/bun.lock
	@$(MAKE) --no-print-directory -C $(DESKTOP_DIR) install
	@touch $@

# Rechargement à chaud : le main et le preload sont recompilés et Electron
# relancé à chaque sauvegarde ; l'UI vient de la console de `make dev` (HMR de
# Vite). Pour viser la production : `make -C apps/desktop dev`.
desktop: $(DESKTOP_DEPS) ## [DESKTOP] Lance l'app desktop en dev (Electron rechargé à chaud) sur la console locale de make dev.
	@$(MAKE) --no-print-directory -C $(DESKTOP_DIR) dev-local LOCAL_CONSOLE_URL="$(DESKTOP_CONSOLE_URL)"

preview-console: build-console ## Sert le dist de la console sur :1420 (même origine que make dev). Incompatible avec vite.
	$(LOAD_ENV_OPT) bun run --filter console preview

# `make stop` arrête l'environnement de dev local en entier : API, worker,
# console, backoffice et app desktop. Le port ne suffisait pas. Le worker
# n'écoute rien, il survivait donc à chaque arrêt, et deux `make dev` empilés
# finissaient par poser deux workers sur la même file : un run pouvait rester
# en file sans que personne ne le prenne.
#
# Les processus sont reconnus à leur répertoire de travail sous `apps/`, pas
# à un motif de ligne de commande : `bun --watch src/index.ts` est le même
# texte pour l'API, le worker et n'importe quel autre dépôt ouvert à côté.
# L'app desktop compte deux choses : son lanceur bun (cwd apps/desktop) et
# Electron lui-même, reconnu au chemin de son exécutable : electron-vite ne le
# ferme pas quand il reçoit SIGTERM, Electron survivrait sinon à `make stop`.
# Ce qui a sa propre cible n'est pas touché : ni le faux Hermes, ni le lien
# connecteur (`make link-dev-down`).
#
# PORT=<n> garde l'ancien usage : libérer ce seul port, et rien d'autre.
stop: ## [DEV] Arrête l'environnement local (API, worker, console, backoffice, app desktop). PORT=<n> pour ne libérer qu'un port.
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
			"$$root"/apps/api|"$$root"/apps/worker|"$$root"/apps/console|"$$root"/$(DESKTOP_DIR)|"$(ADMIN_DIR)") \
				targets="$$targets $$pid" ;; \
			"$$root") \
				case "$$(ps -o command= -p "$$pid" 2>/dev/null)" in \
					*--filter*dev*) targets="$$targets $$pid" ;; \
				esac ;; \
		esac; \
	done; \
	for pid in $$(pgrep -f "^$$root/$(DESKTOP_DIR)/node_modules/electron/dist/" 2>/dev/null || true); do \
		targets="$$targets $$pid"; \
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
	free_port "$${ADMIN_PORT:-1421}" "Backoffice" || status=$$?; \
	free_port "$${API_PORT:-8790}" "API" || status=$$?; \
	exit $$status

# ─── Dev : lien vers un runtime distant ──────────────────────────────────────
.PHONY: link-dev-up link-dev-down link-dev-status link-mode link-dev-verify link-gateway-install

# TICKET=ask : le ticket est ouvert dans la console (Réglages, Installation,
# fenêtre d'appairage) puis collé sans écho, au lieu de la connexion du compte
# dev. Le runtime arrive alors dans l'espace de celui qui l'a ouvert, un compte
# Google compris, et l'instance est reprise même déjà liée.
# HOST= sur la ligne de commande l'emporte ; sinon LINK_DEV_HOST (Makefile.local).
LINK_DEV_HOST ?=
link_dev_host = $(or $(HOST),$(LINK_DEV_HOST))

link-dev-up: ## [DEV] Relie un runtime distant à ce poste : passerelle, tunnel, enrôlement, en arrière-plan (HOST=user@hôte, sinon LINK_DEV_HOST de Makefile.local ; TICKET=ask : ticket collé depuis la console).
	@ENV_FILE="$(ENV_FILE)" HOST="$(link_dev_host)" LINK_DEV_TICKET="$(TICKET)" bash scripts/link-dev-pass.sh up

link-dev-down: ## [DEV] Arrête ce que `link-dev-up` a démarré, et rien d'autre.
	@ENV_FILE="$(ENV_FILE)" bash scripts/link-dev-pass.sh down

link-dev-status: ## [DEV] Ce qui tourne du lien dev : API, passerelle, tunnel, dernière ligne de journal.
	@ENV_FILE="$(ENV_FILE)" bash scripts/link-dev-pass.sh status

link-mode: ## [DEV] Ce que chaque lien du VPS vise, dev ou production, et comment basculer (HOST=user@vps, sinon LINK_DEV_HOST de Makefile.local).
	@ENV_FILE="$(ENV_FILE)" HOST="$(link_dev_host)" bash scripts/link-dev-pass.sh modes

link-dev-verify: ## [DEV] Passe navigateur de /settings/runtime dans un Chrome jetable (ouvre un ticket local de 5 min ; ne joint aucun hôte).
	@ENV_FILE="$(ENV_FILE)" bash scripts/link-dev-pass.sh verify

link-gateway-install: ## [HERMES] Installe le service utilisateur systemd sans le lancer ni l’activer au démarrage.
	@bun scripts/runtime-link-service.ts --install

# ─── Qualité ─────────────────────────────────────────────────────────────────
.PHONY: typecheck deps-check license-check test-unit test-dual solo-check bundle-budget test-integration test-trace-legacy test check

typecheck: ## Typechecke tous les workspaces actifs, puis tests/, scripts/ et apps/console/scripts (tsconfig.json racine).
	bun run --filter api --filter worker --filter link-gateway --filter console --filter desktop-tauri --filter @openedbot/hermes --filter @openedbot/platform-config --filter @openedbot/platform-db --filter @openedbot/platform-integrations --filter @openedbot/platform-observability --filter @openedbot/platform-plugins --filter '@openedbot/contracts-*' --filter @openedbot/protocol-connector --filter '@openedbot/browser-*' --filter './modules/*' typecheck
	bunx tsc --noEmit -p tsconfig.json

# Seules les couches présentes sont passées : dependency-cruiser refuse un
# chemin absent. tests/ et scripts/ sont cruisés
# avec le reste. L'alias `@/` de chaque application n'est résolu qu'avec son
# propre tsconfig : deux passes ciblées l'ajoutent pour voir les cycles internes.
deps-check: ## Frontières entre applications, paquets et couches (.dependency-cruiser.cjs), tests/ et scripts/ compris, sans build.
	bun tests/scripts/workspace-deps-contract.ts
	bun tests/scripts/permission-port-contract.ts
	bun tests/scripts/subscription-port-contract.ts
	bun tests/scripts/payment-provider-contract.ts
	bunx depcruise --config .dependency-cruiser.cjs --output-type err $(wildcard apps platform contracts protocol/connector browser modules tests scripts)
	bunx depcruise --config .dependency-cruiser.cjs --output-type err --ts-config $(CURDIR)/apps/console/tsconfig.json apps/console
	$(MAKE) --no-print-directory license-check

license-check: ## Licences des paquets tiers de bun.lock (transitifs compris) : aucun GPL ni AGPL ; LGPL et MPL listés.
	bun scripts/license-scan.ts

UNIT_CONSOLE_BATCH_SIZE ?= 1

test-unit: ## Tests unitaires API, Worker, Web, contrats, plateforme, modules et scripts, sans réseau ni PostgreSQL.
	bun test $$(find apps/api/tests -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) ! -name '*.e2e.test.ts' | sort) apps/worker/tests apps/link-gateway/tests contracts/api/tests contracts/i18n/tests contracts/primitives/tests protocol/connector/tests browser/api-client/src browser/face/src browser/ui-kit/src platform/hermes/tests platform/config/tests platform/db/tests platform/integrations/tests platform/observability/tests platform/plugins/tests $(wildcard modules/*/tests) tests/fake-hermes tests/fake-push tests/fake-apns
	bun test scripts/lib tests/e2e/bot/kit tests/scripts/run-writes-contract.test.ts tests/scripts/run-events-contract.test.ts tests/scripts/runtime-client-contract.test.ts tests/scripts/foreign-reads-contract.test.ts apps/desktop-tauri/scripts
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
# (test-dual, solo-check, dev-admin…) exigent le checkout des plug-ins en ./plugins.
PRO_PLUGIN_ENTRIES ?= packages/pro-staff/src/plugin.ts packages/pro-audit/src/index.ts packages/pro-agency/src/index.ts packages/pro-permissions/src/index.ts packages/pro-billing/src/index.ts
pro_comma := ,
pro_empty :=
pro_space := $(pro_empty) $(pro_empty)
PRO_PLUGINS_LIST = $(subst $(pro_space),$(pro_comma),$(strip $(if $(plugins_dir),$(foreach entry,$(PRO_PLUGIN_ENTRIES),$(plugins_dir)/$(entry)))))
# Les écrans pro de la console (étape 9) : un module console par paquet pro
# (`console/index.ts`), chargé par OPENEDBOT_CONSOLE_PLUGINS (`apps/console/vite-pro-console.ts`,
# et `test-setup.ts` pour les tests). La facturation a son paquet depuis
# l'étape 8d (`pro-billing/console`) ; plus aucune amorce du cœur ici.
PRO_CONSOLE_ENTRIES ?= packages/pro-agency/console/index.ts packages/pro-permissions/console/index.ts packages/pro-billing/console/index.ts
PRO_CONSOLE_CORE_MODULES ?=
PRO_CONSOLE_LIST = $(subst $(pro_space),$(pro_comma),$(strip $(if $(plugins_dir),$(foreach entry,$(PRO_CONSOLE_ENTRIES),$(plugins_dir)/$(entry))) $(PRO_CONSOLE_CORE_MODULES)))

test-dual: ## Tests unitaires deux fois : solo (sans plug-in), puis avec les plug-ins externes (./plugins).
	@echo "== test-dual : solo (OPENEDBOT_PLUGINS et OPENEDBOT_CONSOLE_PLUGINS vides)"
	OPENEDBOT_PLUGINS= OPENEDBOT_CONSOLE_PLUGINS= $(MAKE) test-unit
	@test -f "plugins/packages/pro-staff/src/plugin.ts" || { echo "test-dual : pas de plug-ins dans ./plugins (clonez ou liez le checkout des plug-ins en ./plugins)"; exit 2; }
	$(MAKE) -C plugins link-core OPENEDBOT_MAIN_DIR=$(CURDIR)
	@echo "== test-dual : pro (OPENEDBOT_PLUGINS=$(PRO_PLUGINS_LIST) OPENEDBOT_CONSOLE_PLUGINS=$(PRO_CONSOLE_LIST))"
	OPENEDBOT_PLUGINS=$(PRO_PLUGINS_LIST) OPENEDBOT_CONSOLE_PLUGINS=$(PRO_CONSOLE_LIST) $(MAKE) test-unit

# Ce qu'un lancement de la console solo télécharge, sous les budgets de l'ADR
# 0001 (G2) : chunk d'entrée et premier chargement, en gzip
# (`apps/console/scripts/bundle-budget.ts`). Build solo dans BUNDLE_BUDGET_DIR,
# jamais dans apps/console/dist, sans .env.local ni plug-ins : la CI le joue.
BUNDLE_BUDGET_DIR ?= $(or $(TMPDIR),/tmp/)openedbot-bundle-budget

bundle-budget: ## Budget du bundle de la console solo (entrée, premier chargement), en gzip.
	@rm -rf "$(BUNDLE_BUDGET_DIR)" && mkdir -p "$(BUNDLE_BUDGET_DIR)"
	cd apps/console && OPENEDBOT_CONSOLE_PLUGINS= OPENEDBOT_CONSOLE_MODULE_REPORT="$(BUNDLE_BUDGET_DIR)/report.json" ./node_modules/.bin/vite build --logLevel warn --outDir "$(BUNDLE_BUDGET_DIR)/dist" --emptyOutDir
	bun apps/console/scripts/bundle-budget.ts "$(BUNDLE_BUDGET_DIR)/dist" "$(BUNDLE_BUDGET_DIR)/report.json"
	@rm -rf "$(BUNDLE_BUDGET_DIR)"

# La console solo ne contient aucun écran pro (agence, facturation, règles de
# permission) : un build Vite sans OPENEDBOT_CONSOLE_PLUGINS, dont le rapport de modules
# (`vite-module-report.ts`) est lu par `apps/console/scripts/solo-bundle-check.ts`,
# puis le contrôle inverse (le build pro les contient tous), puis deps-check
# (règle `console-sans-ecrans-pro`) et test-dual (instantanés de routes et
# portes par droit, tests/pro-console). Builds dans SOLO_CHECK_DIR, jamais dans
# apps/console/dist, sans .env.local ni réseau.
SOLO_CHECK_DIR ?= $(or $(TMPDIR),/tmp/)openedbot-solo-check
# The pro screens' strings, which `solo-bundle-strings.ts` must find in the pro
# build and nowhere in the solo one (with the pro routes and agency.css).
SOLO_CHECK_MESSAGES = $(if $(plugins_dir),$(sort $(wildcard $(plugins_dir)/packages/*/console/messages.*.ts)))
solo-check: ## Console solo sans aucun écran pro (bundle et routes), contrôle pro, deps-check et test-dual.
	@test -f "plugins/packages/pro-staff/src/plugin.ts" || { echo "solo-check : pas de plug-ins dans ./plugins (clonez ou liez le checkout des plug-ins en ./plugins)"; exit 2; }
	@rm -rf "$(SOLO_CHECK_DIR)" && mkdir -p "$(SOLO_CHECK_DIR)"
	@echo "== solo-check : build solo (OPENEDBOT_CONSOLE_PLUGINS vide)"
	cd apps/console && OPENEDBOT_CONSOLE_PLUGINS= OPENEDBOT_CONSOLE_MODULE_REPORT="$(SOLO_CHECK_DIR)/solo.json" ./node_modules/.bin/vite build --logLevel warn --outDir "$(SOLO_CHECK_DIR)/solo" --emptyOutDir
	bun apps/console/scripts/solo-bundle-check.ts solo "$(SOLO_CHECK_DIR)/solo.json"
	bun apps/console/scripts/solo-bundle-strings.ts solo "$(SOLO_CHECK_DIR)/solo" $(SOLO_CHECK_MESSAGES)
	$(MAKE) -C plugins link-core OPENEDBOT_MAIN_DIR=$(CURDIR)
	@echo "== solo-check : build pro (OPENEDBOT_CONSOLE_PLUGINS=$(PRO_CONSOLE_LIST))"
	cd apps/console && OPENEDBOT_CONSOLE_PLUGINS=$(PRO_CONSOLE_LIST) OPENEDBOT_CONSOLE_MODULE_REPORT="$(SOLO_CHECK_DIR)/pro.json" ./node_modules/.bin/vite build --logLevel warn --outDir "$(SOLO_CHECK_DIR)/pro" --emptyOutDir
	bun apps/console/scripts/solo-bundle-check.ts pro "$(SOLO_CHECK_DIR)/pro.json"
	bun apps/console/scripts/solo-bundle-strings.ts pro "$(SOLO_CHECK_DIR)/pro" $(SOLO_CHECK_MESSAGES)
	@rm -rf "$(SOLO_CHECK_DIR)"
	$(MAKE) deps-check
	$(MAKE) test-dual

# PostgreSQL RLS and import fault injection against a loopback fake Hermes.
# CI supplies PostgreSQL URLs; the import proof never starts a service.
test-integration: $(if $(INTEGRATION_DATABASE_URL),,db-up) ## PostgreSQL jetable : migrations, RLS et imports avec faux Hermes local.
	bash tests/integration/postgres-rls.sh
	bun tests/integration/runtime-direct-access.ts
	bun tests/integration/profile-imports-runner.ts
	bun tests/integration/worker-tenant-scope.ts
	bun tests/integration/worker-queue-probe.ts
	# Les routes de flotte sont celles du plug-in (étape 11.2) : chargé depuis ./plugins s'il existe, sinon le test le dit et passe.
	OPENEDBOT_PLUGINS=$(PRO_PLUGINS_LIST) bun tests/integration/agency-workspaces.ts
	bun tests/integration/thread-history.ts
	bun tests/integration/runtime-link-alerts.ts
	bun tests/integration/alert-channels.ts
	bun tests/integration/dm-without-workflow.ts
	bun tests/integration/orphan-unknown-runs.ts
	bun tests/integration/run-event-sequences.ts
	bun tests/integration/run-transitions.ts
	bun tests/integration/execution-commands.ts
	bun tests/integration/permission-policy-preflight.ts
	bun tests/integration/review-profiles.ts
	bun tests/integration/approval-review.ts
	bun tests/integration/organization-permission-policy.ts
	bun tests/integration/tool-policies.ts
	bun tests/integration/permission-rules.ts
	bun tests/integration/permission-grants.ts
	bun tests/integration/decision-trace.ts
	bun tests/integration/named-coordination.ts
	bun tests/integration/fast-path-stream.ts
	bun tests/integration/routine-tool.ts
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
	bun tests/integration/a2a-audit.ts
	bun tests/integration/a2a-policy-audit-postgres.ts
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
TRACE_LEGACY_REF ?= edge-setup/v1.5.0
test-trace-legacy: $(if $(INTEGRATION_DATABASE_URL),,db-up) ## Preuve S7 avec un connecteur déjà publié (TRACE_LEGACY_REF, défaut edge-setup/v1.5.0) ; exige go et le tag.
	OPENEDBOT_TRACE_E2E_LEGACY_REF=$(TRACE_LEGACY_REF) bun tests/integration/run-trace-correlation.ts

test: test-unit test-integration ## Unitaires et intégration.

check: env-audit typecheck deps-check test build-cloud ## Garde complète: environnement, code, tests et builds cloud.

# ─── Desktop Tauri (prototype D2a, ADR 0001 §4.3.1) ──────────────────────────
# Le shell Rust (`apps/desktop-tauri/src-tauri`) embarque la console solo en
# mode desktop. Rien n'est publié : le build signé reste dans
# `apps/desktop-tauri/release/<version>/`, le flux de mise à jour est servi en
# boucle locale. Clés : Developer ID dans le trousseau, notarisation et clé de
# mise à jour hors du dépôt (`scripts/build-mac.ts`).
.PHONY: desktop-tauri-bindings desktop-tauri-check desktop-tauri-mac desktop-tauri-feed desktop-tauri-publish
DESKTOP_TAURI_DIR := apps/desktop-tauri
TAURI_VERSION ?=
TAURI_SIGN ?= developer-id
TAURI_POPUP ?=

desktop-tauri-bindings: ## [DESKTOP] Régénère le contrat du pont natif (contracts/native-bridge) depuis les commandes Rust.
	cd $(DESKTOP_TAURI_DIR)/src-tauri && cargo run --quiet --example export-bindings -- ../../../contracts/native-bridge/src/bindings.ts

desktop-tauri-check: ## [DESKTOP] cargo test (refus IPC, refresh mono-vol, coffre, popup, bindings à jour) et cargo clippy -D warnings.
	cd $(DESKTOP_TAURI_DIR)/src-tauri && cargo test --quiet && cargo clippy --all-targets --quiet -- -D warnings

desktop-tauri-mac: ## [DESKTOP] Build macOS signé Developer ID, notarisé, agrafé + artefact de mise à jour signé : TAURI_VERSION=X.Y.Z [TAURI_SIGN=adhoc] [TAURI_POPUP=…/OpenedbotPopup.app].
	@[ -n "$(TAURI_VERSION)" ] || { echo "TAURI_VERSION=X.Y.Z est requis"; exit 1; }
	bun $(DESKTOP_TAURI_DIR)/scripts/build-mac.ts --version "$(TAURI_VERSION)" --sign "$(TAURI_SIGN)" $(if $(TAURI_POPUP),--popup "$(TAURI_POPUP)")

desktop-tauri-feed: ## [DESKTOP] Sert le flux de mise à jour local sur http://127.0.0.1:8799/latest.json.
	bun $(DESKTOP_TAURI_DIR)/scripts/update-feed.ts serve --port 8799

desktop-tauri-publish: ## [DESKTOP] Publie localement une version construite dans le flux : TAURI_VERSION=X.Y.Z.
	@[ -n "$(TAURI_VERSION)" ] || { echo "TAURI_VERSION=X.Y.Z est requis"; exit 1; }
	bun $(DESKTOP_TAURI_DIR)/scripts/update-feed.ts publish --version "$(TAURI_VERSION)" --port 8799

# ─── Desktop Tauri Linux (D5, ADR 0001 §4.3.3) ───────────────────────────────
# Tout passe par l'image `apps/desktop-tauri/linux/Dockerfile` (Ubuntu 24.04,
# WebKitGTK 4.1) : x86_64 émulé sur un Mac arm64 (OrbStack), aarch64 natif.
# Les paquets restent dans `apps/desktop-tauri/dist-linux/<version>/<arch>/`
# (ignoré), les preuves du parcours dans `dist-linux/e2e/`. Rien n'est publié.
.PHONY: desktop-tauri-linux desktop-tauri-linux-check desktop-tauri-linux-e2e desktop-tauri-linux-update
TAURI_LINUX_ARCH ?= x86_64
TAURI_FROM ?=
TAURI_TO ?=

desktop-tauri-linux: ## [DESKTOP] Paquets Linux deb + AppImage (+ artefact de mise à jour signé) construits dans Docker : TAURI_VERSION=X.Y.Z [TAURI_LINUX_ARCH=x86_64|aarch64].
	@[ -n "$(TAURI_VERSION)" ] || { echo "TAURI_VERSION=X.Y.Z est requis"; exit 1; }
	bun $(DESKTOP_TAURI_DIR)/scripts/build-linux.ts --docker --version "$(TAURI_VERSION)" --arch "$(TAURI_LINUX_ARCH)"

desktop-tauri-linux-check: ## [DESKTOP] Dans Docker, comme la CI : cargo test, coffre Secret Service, cargo clippy -D warnings (Linux).
	bun $(DESKTOP_TAURI_DIR)/scripts/linux-docker.ts check --arch "$(TAURI_LINUX_ARCH)"

desktop-tauri-linux-e2e: ## [DESKTOP] Parcours réel sous Xvfb contre l'API locale (make dev) : connexion, fils, streaming, coffre, relances : TAURI_VERSION=X.Y.Z.
	@[ -n "$(TAURI_VERSION)" ] || { echo "TAURI_VERSION=X.Y.Z est requis"; exit 1; }
	bun $(DESKTOP_TAURI_DIR)/scripts/linux-docker.ts e2e --version "$(TAURI_VERSION)" --arch "$(TAURI_LINUX_ARCH)"

desktop-tauri-linux-update: ## [DESKTOP] L'AppImage se met à jour par le flux local puis refuse une signature étrangère : TAURI_FROM=X.Y.Z TAURI_TO=X.Y.Z-test.
	@[ -n "$(TAURI_FROM)" ] && [ -n "$(TAURI_TO)" ] || { echo "TAURI_FROM et TAURI_TO sont requis"; exit 1; }
	bun $(DESKTOP_TAURI_DIR)/scripts/linux-docker.ts update --from "$(TAURI_FROM)" --to "$(TAURI_TO)" --arch "$(TAURI_LINUX_ARCH)"

# ─── Contrat connecteur ──────────────────────────────────────────────────────
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

contract-check: ## [contrat] Copies identiques des fixtures du fil, puis tests Go et TS du connecteur (EDGE_SETUP_DIR, défaut edge-setup/).
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

# ─── E2E et charge ───────────────────────────────────────────────────────────
.PHONY: e2e-api e2e-bot e2e-bot-keep e2e-bot-bench e2e-fresh-setup e2e-onboarding e2e-support-ui e2e-hermes e2e-support
.PHONY: e2e-link e2e-link-load e2e-link-separation e2e-link-continuity e2e-push email-preview e2e-email load

e2e-api: ## Parcours HTTP cloud; exige la stack locale déjà lancée (make dev).
	@$(REQUIRE_API)
	$(LOAD_ENV_OPT) bun tests/e2e/api-cloud.ts

e2e-bot: ## Bots e2e sur le runtime lié (SCENARIOS=lifecycle|greeting|fast-path|coordination|model-reset|permissions|all, ARGS=...); rapport HTML dans tmp/e2e-bot/; exige make dev.
	@$(REQUIRE_API)
	@printf '$(C_WARN)[make]$(C_RESET) Inférence réelle : bots jetables, purgés et nettoyage hôte vérifié avant la fin.\n'
	$(LOAD_ENV_OPT) E2E_ALLOW_REAL_RUNS=1 bun tests/e2e/bot/run.ts $(or $(SCENARIOS),lifecycle) $(ARGS)

e2e-bot-keep: ## Idem en scénario lifecycle, mais LAISSE le bot vivant pour inspection dans la console (à purger soi-même).
	@$(REQUIRE_API)
	@printf '$(C_WARN)[make]$(C_RESET) le bot créé NE sera PAS purgé : la base ne sera pas rendue telle quelle.\n'
	$(LOAD_ENV_OPT) E2E_ALLOW_REAL_RUNS=1 bun tests/e2e/bot/run.ts lifecycle --keep $(ARGS)

e2e-bot-bench: ## Bench bots : création vers première question (SAMPLES=3) et tours d'un bot prêt (MESSAGES=5), p50/p95/max dans le rapport HTML.
	@$(REQUIRE_API)
	@printf '$(C_WARN)[make]$(C_RESET) Inférence réelle : bots jetables, purgés et nettoyage hôte vérifié avant la fin.\n'
	$(LOAD_ENV_OPT) E2E_ALLOW_REAL_RUNS=1 bun tests/e2e/bot/run.ts greeting fast-path --samples $(or $(SAMPLES),3) --messages $(or $(MESSAGES),5) --label bench $(ARGS)

e2e-fresh-setup: ## Parcours UI déterministe sans agent, clé ni canal SSH.
	cd apps/console && bun test tests/e2e/fresh-setup.e2e.test.tsx

e2e-onboarding: ## Vérifie l’ordre shadcn fournisseur/modèle et les gates d’inférence.
	cd apps/console && bun test tests/e2e/onboarding-runtime.e2e.test.tsx

e2e-support-ui: ## Guichet de support AU NAVIGATEUR : markdown rendu, capture affichée, compteurs, infobulle du rail (exige make dev).
	@$(REQUIRE_API)
	@curl -fsS "http://localhost:1421/" >/dev/null 2>&1 \
		|| { echo "Backoffice indisponible sur :1421 : lancer « make dev-admin » (backoffice, plug-in externe)." >&2; exit 1; }
	@# Résolu depuis apps/console, comme le script : playwright y est déclaré, et
	@# bun le range sous node_modules/.bun/ (pas à la racine) depuis qu'il isole.
	@cd apps/console && bun -e 'await import("playwright")' >/dev/null 2>&1 \
		|| { echo "Playwright absent de apps/console : « bun install » à la racine, puis « cd apps/console && bunx playwright install chromium »." >&2; exit 1; }
	$(LOAD_ENV_OPT) bun apps/console/scripts/support-desk-pass.ts

e2e-hermes: ## Canari live non destructif contre DEV_HERMES_URL (HTTPS, ou origine déclarée dans HERMES_ALLOW_INSECURE_ORIGINS).
	$(LOAD_ENV) bun tests/e2e/hermes-contract.ts

e2e-support: ## Guichet de support en HTTP pur : un visiteur écrit, le staff voit la trame arriver et répond; aucun modèle appelé.
	@$(REQUIRE_API)
	$(LOAD_ENV_OPT) bun tests/e2e/support-desk.ts

e2e-link: ## Enrôle un runtime par le lien connecteur contre l'API locale (make dev) et un faux Hermes en processus.
	@$(REQUIRE_API)
	$(LOAD_ENV_OPT) bun tests/e2e/link-connector.ts

e2e-link-load: ## k6 E2E du lien réel API → VPS : santé, charge bornée, journal et rapport; aucun modèle sollicité.
	@printf '$(C_SECTION)[make]$(C_RESET) E2E k6 sur le runtime réellement connecté.\n'
	@$(LOAD_ENV_OPT) bun tests/e2e/connector-live-k6.ts

e2e-link-separation: ## Vérifie la passerelle isolée, les flux et les coupures sur des processus de test jetables.
	@printf '$(C_SECTION)[make]$(C_RESET) Régression transport Go/TS avec redémarrages API simulés.\n'
	@OPENEDBOT_LINK_GATEWAY_E2E=1 bun test apps/api/tests/runtime-link-separation.e2e.test.ts

e2e-link-continuity: ## Recette réelle opt-in : fournisseur explicite, cycle bot et observation du lien.
	@printf '$(C_WARN)[make]$(C_RESET) Inférence réelle : E2E_ALLOW_REAL_RUNS=1 et runtime/modèle explicites requis.\n'
	@$(LOAD_ENV_OPT) bun tests/e2e/runtime-link-live-continuity.ts

e2e-push: ## Web Push contre un serveur simulé (jamais FCM/Mozilla); exige la stack locale déjà lancée, PUSH_VAPID_* et PUSH_ALLOW_LOOPBACK_ENDPOINTS=1.
	@$(REQUIRE_API)
	$(LOAD_ENV_OPT) bun tests/e2e/push.ts

email-preview: ## Rend chaque gabarit d'e-mail dans tmp/email-preview/ (HTML + texte, fr et en) ; n'envoie rien.
	rm -rf tmp/email-preview
	bun scripts/email-preview.ts

e2e-email: ## E-mail transactionnel SMTP vers Mailpit (infra-mailpit :1025/:8025) ; s'arrête proprement s'il est absent.
	$(LOAD_ENV_OPT) bun tests/e2e/email.ts

load: ## Banc de charge local (SSE, conversations en boucle, faux Hermes en streaming) : LOAD_SESSIONS=50|100|200|500, LOAD_DURATION_SECONDS, LOAD_CONVERSATIONS ; rapport dans tmp/load/latest.
	bash tests/load/run.sh

# ─── Build ───────────────────────────────────────────────────────────────────
# Les artefacts sont construits SUR LE POSTE (make build-*). La preuve locale
# combine typecheck, tests unitaires, contrats et, pour les changements de
# runtime, l'application locale reliée à un runtime distant (make link-dev-up).
# Le déploiement lui-même n'est pas dans ce dépôt.
.PHONY: build build-console build-admin build-api build-alerting build-cloud deploy

DEPLOY_APPS_ACTIVE ?= console
DEPLOY_APPS := $(if $(APP),$(APP),$(DEPLOY_APPS_ACTIVE))
comma := ,
DEPLOY_APP_LIST := $(subst $(comma), ,$(DEPLOY_APPS))

# URL interne de l'API figée dans le backoffice à la construction. Le build de
# production refuse une origine loopback ; le service `api` est le relais
# interne du stack de production.
DEPLOY_API_INTERNAL_URL ?= http://api:8790

# `make build` livre les artefacts du rôle alpha : même garde qu'un déploiement
# dès que la console en fait partie (une console solo par oubli de
# OPENEDBOT_CONSOLE_PLUGINS est refusée, OPENEDBOT_CONSOLE_MODE=solo l'assume). La garde passe
# AVANT tout build, y compris en -j : les builds sont relancés après elle.
build: $(if $(filter console,$(DEPLOY_APP_LIST)),prod-console-guard) ## [deploy] Construit les artefacts des applications actives (ou APP=console,admin).
	@$(MAKE) --no-print-directory $(addprefix build-,$(DEPLOY_APP_LIST))

build-console: ## [deploy] Construit la console web (apps/console/dist), sans rien déployer.
	$(LOAD_ENV_OPT) bun run --filter console build

build-admin: ## [deploy] Construit le backoffice staff (plug-in externe, ADMIN_DIR), sans rien déployer.
	@$(REQUIRE_ADMIN)
	$(LOAD_ENV_OPT) API_INTERNAL_URL="$(DEPLOY_API_INTERNAL_URL)" bun run --cwd $(ADMIN_DIR) build

build-api: ## Construit API et worker.
	mkdir -p dist/bin
	bun build apps/api/src/index.ts --target=bun --outfile=dist/bin/openedbot-api
	bun build apps/worker/src/index.ts --target=bun --outfile=dist/bin/openedbot-worker

build-alerting: ## Construit la sonde d'alerting interne.
	mkdir -p dist/bin
	bun build apps/api/src/alerting/index.ts --target=bun --outfile=dist/bin/openedbot-alerting

build-cloud: build-api build-alerting build-console ## Construit les services et la SPA déployables.

deploy: ## Refuse : le déploiement n'est pas dans ce dépôt ; make build construit les artefacts.
	@printf '$(C_ERR)[make]$(C_RESET) Le déploiement n'"'"'est pas dans ce dépôt : make build construit les artefacts.\n' >&2; exit 2

# ─── Prod : garde de build et lien de production ─────────────────────────────
.PHONY: prod-console-guard link-prod

# La console hébergée porte les écrans des plug-ins (étape 9) : sans OPENEDBOT_CONSOLE_PLUGINS,
# `build-console` sortirait une console solo, sans agence, facturation ni
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

link-prod: ## [OPS] Bascule le VPS sur la production ; le ticket est demandé à l’invite masquée du VPS (HOST=user@vps).
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

# ─── Worktrees ───────────────────────────────────────────────────────────────
# Un chantier = une branche = un worktree `.worktrees/<NAME>` dans ce dépôt
# (dossier ignoré par git), créé depuis
# `develop` (branche de travail quotidienne). Retour : `make wt-merge` depuis le
# checkout qui reçoit, puis `make wt-rm`. Après une fusion de `develop` dans
# `main`, `make wt-sync` réaligne `develop` sur `main` et pousse les deux.
.PHONY: wt-new wt-ls wt-merge wt-rm wt-sync

WT_BASE ?= develop
WT_ROOT ?= $(CURDIR)/.worktrees
WT_DIR   = $(WT_ROOT)/$(NAME)
# Les réglages non versionnés du poste : le fichier d'env unique et Makefile.local.
WT_LOCAL_FILES = .env.local Makefile.local

define wt_need_name
	@if [ -z "$(NAME)" ]; then printf '$(C_ERR)[make]$(C_RESET) NAME est requis (ex. NAME=openedbot-71).\n' >&2; exit 2; fi; \
	case "$(NAME)" in *[!A-Za-z0-9._/-]*|-*|*/) printf '$(C_ERR)[make]$(C_RESET) NAME invalide : %s\n' "$(NAME)" >&2; exit 2 ;; esac
endef

wt-new: ## Crée le worktree .worktrees/NAME sur la branche NAME (créée depuis WT_BASE=develop si absente) et y copie .env.local et Makefile.local.
	$(wt_need_name)
	@if [ -e "$(WT_DIR)" ]; then printf '$(C_WARN)[make]$(C_RESET) %s existe déjà.\n' "$(WT_DIR)"; exit 0; fi; \
	git fetch -q origin; mkdir -p "$(WT_ROOT)"; \
	if git show-ref --verify --quiet "refs/heads/$(NAME)"; then \
		git worktree add "$(WT_DIR)" "$(NAME)"; \
	elif git show-ref --verify --quiet "refs/remotes/origin/$(NAME)"; then \
		git worktree add --track -b "$(NAME)" "$(WT_DIR)" "origin/$(NAME)"; \
	else \
		git worktree add -b "$(NAME)" "$(WT_DIR)" "$(WT_BASE)"; \
	fi; \
	copied=0; for f in $(WT_LOCAL_FILES); do \
		if [ -f "$$f" ] && [ ! -e "$(WT_DIR)/$$f" ]; then cp "$$f" "$(WT_DIR)/$$f"; copied=$$((copied+1)); fi; \
	done; \
	printf '$(C_OK)[make]$(C_RESET) Worktree %s sur %s (%s fichiers locaux copiés). Ensuite : cd %s && bun install\n' "$(WT_DIR)" "$(NAME)" "$$copied" "$(WT_DIR)"

wt-ls: ## Liste les worktrees et dit si leur branche est déjà fusionnée dans HEAD.
	@git worktree list --porcelain | awk '/^worktree /{p=$$2} /^branch /{sub("refs/heads/","",$$2); print p"\t"$$2}' | while IFS="$$(printf '\t')" read -r path branch; do \
		if [ "$$branch" = "$$(git rev-parse --abbrev-ref HEAD)" ]; then state="(ici)"; \
		elif git merge-base --is-ancestor "$$branch" HEAD 2>/dev/null; then state="$(C_OK)fusionnée$(C_RESET)"; \
		else state="$(C_WARN)non fusionnée$(C_RESET)"; fi; \
		printf '  $(C_TARGET)%-24s$(C_RESET) %s  %b\n' "$$branch" "$$path" "$$state"; \
	done

wt-merge: ## Fusionne la branche NAME (no-ff) dans la branche de ce checkout ; refuse un arbre sale.
	$(wt_need_name)
	@if [ -n "$$(git status --porcelain --untracked-files=no)" ]; then printf '$(C_ERR)[make]$(C_RESET) Arbre sale : committer ou remiser avant de fusionner.\n' >&2; exit 2; fi; \
	git merge --no-ff "$(NAME)" && printf '$(C_OK)[make]$(C_RESET) %s fusionnée dans %s. Puis : make wt-rm NAME=%s\n' "$(NAME)" "$$(git rev-parse --abbrev-ref HEAD)" "$(NAME)"

wt-rm: ## Supprime le worktree .worktrees/NAME et la branche NAME, seulement si elle est fusionnée dans HEAD (FORCE=1 pour passer outre).
	$(wt_need_name)
	@if [ -z "$(FORCE)" ] && ! git merge-base --is-ancestor "$(NAME)" HEAD 2>/dev/null; then \
		printf '$(C_ERR)[make]$(C_RESET) %s n'"'"'est pas fusionnée dans HEAD ; make wt-merge NAME=%s d'"'"'abord, ou FORCE=1.\n' "$(NAME)" "$(NAME)" >&2; exit 2; fi; \
	if [ -e "$(WT_DIR)" ]; then git worktree remove $(if $(FORCE),--force) "$(WT_DIR)"; fi; \
	git worktree prune; \
	git branch $(if $(FORCE),-D,-d) "$(NAME)" 2>/dev/null || true; \
	printf '$(C_OK)[make]$(C_RESET) Worktree et branche %s retirés.\n' "$(NAME)"

wt-sync: ## Après une fusion de develop dans main : réaligne develop sur main (fast-forward) et pousse main + develop.
	@if [ "$$(git rev-parse --abbrev-ref HEAD)" != "main" ]; then printf '$(C_ERR)[make]$(C_RESET) À lancer depuis main.\n' >&2; exit 2; fi; \
	if ! git merge-base --is-ancestor develop main; then printf '$(C_ERR)[make]$(C_RESET) develop a des commits que main n'"'"'a pas : make wt-merge NAME=develop d'"'"'abord.\n' >&2; exit 2; fi; \
	git branch -f develop main && git push origin main develop && printf '$(C_OK)[make]$(C_RESET) main et develop alignées sur %s et poussées.\n' "$$(git rev-parse --short main)"

# ─── Nettoyage ───────────────────────────────────────────────────────────────
.PHONY: clean

clean: ## Supprime uniquement les artefacts générés; jamais .data ni PostgreSQL.
	rm -rf dist apps/api/dist apps/console/dist

# ─── Fragments privés ────────────────────────────────────────────────────────
# Seul point d'extension : les fragments make du checkout des plug-ins
# (plugins/make/*.mk, ignoré par git). Absents, rien n'est inclus.
-include $(wildcard $(CURDIR)/plugins/make/*.mk)
