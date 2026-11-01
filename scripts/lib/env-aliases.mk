# One-release fallback for the OHB_* -> OPENEDBOT_* rename (Makefile side),
# for the variables the recipes expand themselves ($(NAME)) or hand to a
# sub-make. An old name given on the command line or in the environment
# becomes the new one (unless the new one is given too), with one warning.
# The env file is covered by scripts/lib/env-aliases.sh (LOAD_ENV).
# Delete in the release after the rename.

# $(call openedbot_legacy_var,OLD,NEW)
define openedbot_legacy_var
ifneq ($$(origin $(1)),undefined)
ifeq ($$(filter environment command line,$$(origin $(2))),)
$$(warning $(1) is deprecated: rename it to $(2) (old name read for one more release))
$(2) := $$($(1))
export $(2)
endif
unexport $(1)
endif
endef

$(eval $(call openedbot_legacy_var,OHB_PRO_PLUGINS,OPENEDBOT_PLUGINS))
$(eval $(call openedbot_legacy_var,OHB_PRO_CONSOLE,OPENEDBOT_CONSOLE_PLUGINS))
$(eval $(call openedbot_legacy_var,OHB_CONSOLE_SOLO,OPENEDBOT_CONSOLE_SOLO))
$(eval $(call openedbot_legacy_var,OHB_PUBLIC_URL,OPENEDBOT_PUBLIC_URL))
$(eval $(call openedbot_legacy_var,OHB_CONSOLE_URL,OPENEDBOT_CONSOLE_URL))
$(eval $(call openedbot_legacy_var,OHB_CORE_DIR,OPENEDBOT_CORE_DIR))
