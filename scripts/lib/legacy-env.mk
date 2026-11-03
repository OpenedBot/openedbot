# Refuses a retired OHB_* variable given on the command line or in the
# environment (Makefile side). They are no longer read: rather than run a
# recipe with a setting silently lost, make stops before any target. The
# env file itself is checked by scripts/lib/legacy-env.sh (LOAD_ENV), and
# `make env-prune` rewrites it, values kept. Names only, never a value.

OPENEDBOT_LEGACY_ENV := $(sort $(foreach name,$(filter OHB_%,$(.VARIABLES)),$(if $(or $(findstring environment,$(origin $(name))),$(findstring command,$(origin $(name)))),$(name))))
ifneq ($(OPENEDBOT_LEGACY_ENV),)
$(error the retired OHB_ prefix is no longer read: $(OPENEDBOT_LEGACY_ENV). Set their OPENEDBOT_* names instead (platform/config/src/legacy-env.ts names each successor; make env-prune rewrites .env.local) and unset these)
endif
