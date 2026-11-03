package hermes

import (
	"context"
	"errors"
	"fmt"

	"github.com/OpenedBot/openedbot/edge-setup/internal/account"
	"github.com/OpenedBot/openedbot/edge-setup/internal/egress"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/render"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
)

// GatewayUnitStale is the finding `audit` and `doctor` report for an installed
// gateway unit that is not the one this binary renders, with its remedy. It is
// a warning: the runtime works, it only lacks what a newer release changed in
// the unit (a sandbox directive, the metadata deny).
const GatewayUnitStale = layout.GatewayUnit + ".service differs from the unit this edge-setup renders for this host: " +
	"a fix of the unit has not reached it yet; run `sudo edge-setup upgrade --yes`, or `sudo edge-setup up --yes`"

// gatewayUnitText renders hermes-gateway.service for one set of host facts.
// It is the only place that builds render.GatewayParams: `up` (installUnit),
// `upgrade` and `audit` (DesiredGatewayUnit) all go through it, so the unit an
// installed host is compared with, or brought to, is exactly the one `up`
// writes.
func gatewayUnitText(dockerEnabled bool, uid int, resolvConf string, log func(string, ...any)) (string, error) {
	// The metadata deny must not cut the gateway's own DNS: a resolver inside
	// a denied range stays allowed, alone (internal/egress).
	resolvers := egress.ResolverAllowFrom(resolvConf, layout.GatewayUnit+".service", log)
	return render.GatewayUnit(render.GatewayParams{DockerEnabled: dockerEnabled, UID: uid, EgressAllow: resolvers})
}

// DesiredGatewayUnit renders the gateway unit as `up --yes` would write it on
// this host now, without running `up`. It reads the same inputs `up` does and
// guesses none of them: the sandbox variant is the one recorded in st (a
// replay without flags keeps the selection already made), the uid is the
// service account's and the resolver exceptions come from resolvConf
// (layout.ResolvConf). A host without state, or without the service account,
// is an error: whether the unit differs cannot be told, and nothing may be
// rewritten on a guess.
func DesiredGatewayUnit(ctx context.Context, accounts account.Client, st *state.File, resolvConf string, log func(string, ...any)) (string, error) {
	if st == nil {
		return "", errors.New("no state file: whether the sandbox variant of the gateway unit applies cannot be told")
	}
	info, err := accounts.Get(ctx, layout.ServiceUser)
	if err != nil {
		return "", fmt.Errorf("service account %s: %w", layout.ServiceUser, err)
	}
	if info == nil {
		return "", fmt.Errorf("service account %s is missing: its uid cannot be told", layout.ServiceUser)
	}
	return gatewayUnitText(st.Features.Sandbox, info.UID, resolvConf, log)
}
