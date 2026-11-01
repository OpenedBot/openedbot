# openedbot desktop shell. Bun is the only package manager and runner.
# Nothing here starts on its own: every target is run by hand.

SHELL := /bin/sh
.DEFAULT_GOAL := help
.PHONY: help install typecheck test compile dev dev-local start logs lab popup-check defaults package-win package-win-installer package-mac clean

# ─── Colors ──────────────────────────────────────────────────────────────────
# Defined once, reused by `make help` and by every [make] message below.
C_SECTION := \033[1;33m
C_TARGET  := \033[36m
C_OK      := \033[32m
C_WARN    := \033[33m
C_ERR     := \033[31m
C_RESET   := \033[0m

# ─── Install / Setup ─────────────────────────────────────────────────────────

install: ## Install dependencies with Bun (lockfile: bun.lock)
	@command -v bun >/dev/null 2>&1 || { printf "$(C_ERR)[make] bun is not installed (https://bun.sh)$(C_RESET)\n"; exit 1; }
	@bun install
	@printf "$(C_OK)[make] dependencies installed$(C_RESET)\n"

# ─── Build / Check ───────────────────────────────────────────────────────────

typecheck: ## Type-check the whole project without emitting (tsc --noEmit)
	@bun run typecheck
	@printf "$(C_OK)[make] typecheck passed$(C_RESET)\n"

test: ## Unit tests (bun test): the host <-> popup protocol
	@bun run test
	@printf "$(C_OK)[make] tests passed$(C_RESET)\n"

compile: ## Bundle main and preload to dist/ as CommonJS (electron-vite build)
	@bun run compile
	@printf "$(C_OK)[make] compiled to dist/$(C_RESET)\n"

# ─── Run ─────────────────────────────────────────────────────────────────────

# make dev aims production unless OPENEDBOT_CONSOLE_URL is set: the console on
# https://console.openedbot.app, the API on https://api.openedbot.app (the native
# clients' host). The operator works on the shell against the real service
# (2026-10-17).
# Sign-in is Google only there, and the session lives in its own userData,
# "openedbot (dev prod)" (main.ts). make dev-local aims the local console instead
# (../..: make db-up && make dev), where the UI gets real HMR.
PROD_CONSOLE_URL := https://console.openedbot.app
PROD_API_ORIGIN := https://api.openedbot.app
LOCAL_CONSOLE_URL := http://localhost:1420

dev: ## Electron with reload (electron-vite dev --watch) on production (console console.openedbot.app, API api.openedbot.app): real account, Google sign-in; OPENEDBOT_CONSOLE_URL=... aims elsewhere
	@command -v bun >/dev/null 2>&1 || { printf "$(C_ERR)[make] bun is not installed (https://bun.sh)$(C_RESET)\n"; exit 1; }
	@if [ -z "$$OPENEDBOT_CONSOLE_URL" ]; then printf "$(C_WARN)[make] electron-vite dev on PRODUCTION ($(PROD_CONSOLE_URL), API $(PROD_API_ORIGIN)): real account, real data$(C_RESET)\n"; \
	else printf "$(C_WARN)[make] electron-vite dev (OPENEDBOT_CONSOLE_URL=$$OPENEDBOT_CONSOLE_URL)$(C_RESET)\n"; fi
	@if [ -z "$$OPENEDBOT_CONSOLE_URL" ]; then export OPENEDBOT_CONSOLE_URL="$(PROD_CONSOLE_URL)" OPENEDBOT_API_ORIGIN="$${OPENEDBOT_API_ORIGIN:-$(PROD_API_ORIGIN)}"; \
	else export OPENEDBOT_API_ORIGIN="$${OPENEDBOT_API_ORIGIN:-$$OPENEDBOT_CONSOLE_URL}"; fi; bun run dev

dev-local: ## Electron with reload on the local console :1420 (../.. make dev), seeded dev accounts, console HMR
	@command -v bun >/dev/null 2>&1 || { printf "$(C_ERR)[make] bun is not installed (https://bun.sh)$(C_RESET)\n"; exit 1; }
	@curl -s -o /dev/null --max-time 2 "$(LOCAL_CONSOLE_URL)" || \
		printf "$(C_WARN)[make] nothing answers on $(LOCAL_CONSOLE_URL): start the console first (cd ../.. && make db-up && make dev); the window retries every 5 s$(C_RESET)\n"
	@printf "$(C_WARN)[make] electron-vite dev (OPENEDBOT_CONSOLE_URL=$(LOCAL_CONSOLE_URL))$(C_RESET)\n"
	@OPENEDBOT_CONSOLE_URL="$(LOCAL_CONSOLE_URL)" OPENEDBOT_API_ORIGIN="$(LOCAL_CONSOLE_URL)" bun run dev

start: compile ## Build once, then launch Electron on the configured console (no reload: see make dev)
	@printf "$(C_WARN)[make] launching Electron (OPENEDBOT_CONSOLE_URL=$${OPENEDBOT_CONSOLE_URL:-default})$(C_RESET)\n"
	@bun run start

# The diagnostics journal (src/main/diagnostics.ts) of one userData: "openedbot
# (dev prod)" for make dev, "openedbot (dev)" for make dev-local, "openedbot" for the
# installed app. Read-only, safe while the app runs (WAL).
LOGS_APP ?= openedbot (dev prod)
LOGS_LINES ?= 100
LOGS_DB = $(HOME)/Library/Application Support/$(LOGS_APP)/diagnostics.sqlite

logs: ## Last diagnostics of the shell (LOGS_APP="openedbot" for the installed app, LOGS_LINES=..., LOGS_LEVEL=error)
	@[ -f "$(LOGS_DB)" ] || { printf "$(C_ERR)[make] no journal at $(LOGS_DB)$(C_RESET)\n"; exit 1; }
	@sqlite3 -readonly -separator '  ' "$(LOGS_DB)" \
		"select * from (select id, strftime('%m-%d %H:%M:%S', at / 1000, 'unixepoch', 'localtime'), upper(level), source, message, coalesce(detail, '') \
		from events $(if $(LOGS_LEVEL),where level = '$(LOGS_LEVEL)',) order by id desc limit $(LOGS_LINES)) order by id;" \
		| cut -d' ' -f3-

# ─── Design lab ──────────────────────────────────────────────────────────────

lab: ## Design lab (React + Vite) on http://localhost:5317: every sign-in template live, states, themes, sizes, compare, pick
	@command -v bun >/dev/null 2>&1 || { printf "$(C_ERR)[make] bun is not installed (https://bun.sh)$(C_RESET)\n"; exit 1; }
	@cd design-lab && bun install --silent && bun run dev

# ─── Package ─────────────────────────────────────────────────────────────────

# Optional build-time targets, baked into dist/main/defaults.json (lowest
# precedence after the environment and userData/config.json):
#   make package-win CONSOLE_URL=http://localhost:1420 API_ORIGIN=https://api.example.com
# Without any of them a release is production. TARGET is prod or an API URL.
TARGET      ?=
CONSOLE_URL ?=
API_ORIGIN  ?=
CLIENT_ID   ?=
SIGNIN_TEMPLATE ?=

defaults: compile ## Write dist/main/defaults.json from TARGET / CONSOLE_URL / API_ORIGIN / CLIENT_ID / SIGNIN_TEMPLATE (empty = production)
	@rm -f dist/main/defaults.json
	@if [ -n "$(TARGET)$(CONSOLE_URL)$(API_ORIGIN)$(CLIENT_ID)$(SIGNIN_TEMPLATE)" ]; then \
		printf '{' > dist/main/defaults.json; sep=""; \
		[ -n "$(TARGET)" ] && { printf '%s"target": "%s"' "$$sep" "$(TARGET)" >> dist/main/defaults.json; sep=", "; }; \
		[ -n "$(CONSOLE_URL)" ] && { printf '%s"consoleUrl": "%s"' "$$sep" "$(CONSOLE_URL)" >> dist/main/defaults.json; sep=", "; }; \
		[ -n "$(API_ORIGIN)" ] && { printf '%s"apiOrigin": "%s"' "$$sep" "$(API_ORIGIN)" >> dist/main/defaults.json; sep=", "; }; \
		[ -n "$(CLIENT_ID)" ] && { printf '%s"clientId": "%s"' "$$sep" "$(CLIENT_ID)" >> dist/main/defaults.json; sep=", "; }; \
		[ -n "$(SIGNIN_TEMPLATE)" ] && { printf '%s"signinTemplate": "%s"' "$$sep" "$(SIGNIN_TEMPLATE)" >> dist/main/defaults.json; }; \
		printf '}\n' >> dist/main/defaults.json; \
		printf "$(C_OK)[make] defaults baked: %s$(C_RESET)\n" "$$(cat dist/main/defaults.json)"; \
	else \
		printf "$(C_WARN)[make] no TARGET/CONSOLE_URL/API_ORIGIN given: built-in defaults (console console.openedbot.app, API api.openedbot.app)$(C_RESET)\n"; \
	fi

package-win: defaults ## Portable Windows x64 build (zip of openedbot.exe + resources) into release/; no Wine needed. CONSOLE_URL=... aims a test build
	@printf "$(C_WARN)[make] building an UNSIGNED portable zip (sideload only)$(C_RESET)\n"
	@bun run package:win:zip
	@ls -1 release/*.zip >/dev/null 2>&1 || { printf "$(C_ERR)[make] no .zip produced in release/$(C_RESET)\n"; exit 1; }
	@for f in release/*.zip; do printf "$(C_OK)[make] %s  (%s, sha256 %s)$(C_RESET)\n" "$$f" "$$(du -h "$$f" | cut -f1)" "$$(sha256sum "$$f" | cut -d' ' -f1)"; done

package-win-installer: defaults ## Unsigned Windows x64 NSIS installer (.exe) into release/; cross-building from Linux needs Wine
	@command -v wine >/dev/null 2>&1 || { printf "$(C_ERR)[make] wine is required to build the NSIS installer from Linux (makensis + rcedit run through it). Use make package-win for the portable zip, or build on Windows.$(C_RESET)\n"; exit 1; }
	@printf "$(C_WARN)[make] building an UNSIGNED installer (sideload only)$(C_RESET)\n"
	@bun run package:win:nsis
	@ls -1 release/*.exe >/dev/null 2>&1 || { printf "$(C_ERR)[make] no .exe produced in release/$(C_RESET)\n"; exit 1; }
	@for f in release/*.exe; do printf "$(C_OK)[make] %s  (%s, sha256 %s)$(C_RESET)\n" "$$f" "$$(du -h "$$f" | cut -f1)" "$$(sha256sum "$$f" | cut -d' ' -f1)"; done

# The popup bundle electron-builder embeds (mac.extraFiles). Built in its own
# directory, never copied as source.
POPUP_APP := ../notch/dist/OHBPopup.app

popup-check: ## Check that the popup bundle to embed exists (../notch/dist/OHBPopup.app)
	@[ -x "$(POPUP_APP)/Contents/MacOS/OHBPopup" ] || { printf "$(C_ERR)[make] popup bundle missing: $(POPUP_APP)\n[make] build it first: make -C ../notch bundle$(C_RESET)\n"; exit 1; }
	@[ "$$(/usr/libexec/PlistBuddy -c 'Print :OHBHostedProtocol' '$(POPUP_APP)/Contents/Info.plist' 2>/dev/null)" = "1" ] || { printf "$(C_ERR)[make] $(POPUP_APP) predates hosted mode (no OHBHostedProtocol 1 in its Info.plist)\n[make] rebuild it: make -C ../notch bundle$(C_RESET)\n"; exit 1; }
	@printf "$(C_OK)[make] popup bundle: $(POPUP_APP) (version %s, hosted protocol 1)$(C_RESET)\n" "$$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' '$(POPUP_APP)/Contents/Info.plist' 2>/dev/null || echo '?')"

package-mac: popup-check defaults ## Unsigned macOS arm64 build (dmg + zip) into release/, popup embedded; run it on a Mac
	@[ "$$(uname -s)" = "Darwin" ] || { printf "$(C_ERR)[make] package-mac runs on macOS only (the .dmg is built with hdiutil)$(C_RESET)\n"; exit 1; }
	@printf "$(C_WARN)[make] building an UNSIGNED, non-notarized macOS app (Gatekeeper blocks the first launch)$(C_RESET)\n"
	@bun run package:mac
	@ls -1 release/*.dmg >/dev/null 2>&1 || { printf "$(C_ERR)[make] no .dmg produced in release/$(C_RESET)\n"; exit 1; }
	@for f in release/*.dmg release/*-mac-*.zip; do if [ -f "$$f" ]; then printf "$(C_OK)[make] %s  (%s, sha256 %s)$(C_RESET)\n" "$$f" "$$(du -h "$$f" | cut -f1)" "$$(shasum -a 256 "$$f" | cut -d' ' -f1)"; fi; done

# ─── Clean ───────────────────────────────────────────────────────────────────

clean: ## Remove dist/ and release/ (node_modules is kept)
	@rm -rf dist release
	@printf "$(C_OK)[make] dist/ and release/ removed$(C_RESET)\n"

# ─── Help ────────────────────────────────────────────────────────────────────

help: ## List the targets, grouped by section
	@awk -v S="$(C_SECTION)" -v T="$(C_TARGET)" -v R="$(C_RESET)" 'BEGIN { FS = ":.*## " } \
		/^# ─── Colors/ { next } \
		/^# ─── / { name = $$0; sub(/^# ─── /, "", name); sub(/ ─.*$$/, "", name); printf "\n%s%s%s\n", S, name, R; next } \
		/^[a-zA-Z0-9_-]+:.*## / { printf "  %s%-14s%s %s\n", T, $$1, R, $$2 }' $(MAKEFILE_LIST)
	@printf "\n"
