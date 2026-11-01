#!/usr/bin/env bash
#
# Le lien dev du poste, en une commande, et sa preuve navigateur.
#
# `scripts/link-dev.ts` seul tient le tunnel au premier plan : utile pour regarder,
# pénible pour travailler, et il ne dit rien de la passerelle qu'il exige. En mode
# `separate` cette passerelle est un second processus, sur un autre port, que
# rien ne démarre : sans elle le tunnel s'ouvre sur du vide et l'appairage
# attend jusqu'à l'expiration du ticket sans jamais dire pourquoi.
#
# Ce script monte les deux dans l'ordre, prouve chacun avant de passer au
# suivant, rend la main, et sait défaire exactement ce qu'il a démarré.
#
#   up      passerelle de lien (si `separate`) puis tunnel + enrôlement
#   down    arrête ce que `up` a démarré, et rien d'autre
#   status  ce qui tourne, sur quels ports, avec la dernière ligne de journal
#   modes   ce que chaque lien du VPS vise : dev (ce poste) ou production
#   verify  passe navigateur de l'écran /settings/runtime (Chrome jetable)
#
# Rien n'est publié sur Internet : le tunnel est un `ssh -R` sur la loopback du
# VPS. Le lien de production (instance `default`) n'est pas touché par défaut :
# ce script travaille sur une instance au nom de ce poste (`homelab-01`), sur
# un port VPS propre à elle, sauf si LINK_DEV_INSTANCE / LINK_TUNNEL_PORT
# (.env.local) en décident autrement. N postes se relient donc au même VPS
# sans réglage, chacun sur son instance.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

action="${1:-}"
env_file="${ENV_FILE:-.env.local}"
state_dir="${LINK_DEV_STATE_DIR:-.data/link-dev-pass}"
gateway_pid_file="$state_dir/gateway.pid"
gateway_log_file="$state_dir/gateway.log"
link_pid_file="$state_dir/link.pid"
link_log_file="$state_dir/link.log"

# The gateway and the tunnel outlive the shell that started them. `nohup`
# alone only ignores SIGHUP: both stayed in the caller's process group, so
# closing that terminal (or an agent harness cleaning up its command) killed
# them with no trace in their logs. `setsid` gives them their own session;
# macOS has no `setsid`, there job control gives them their own group.
detach=()
if command -v setsid >/dev/null 2>&1; then detach=(setsid); else set -m; fi

# La couleur suit la convention du Makefile ; NO_COLOR la vide.
if [[ -z "${NO_COLOR:-}" ]]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_RESET=$'\033[0m'
else
  C_OK=''; C_WARN=''; C_ERR=''; C_RESET=''
fi

say()  { printf '%s[link-dev-pass]%s %s\n' "$C_OK" "$C_RESET" "$1"; }
warn() { printf '%s[link-dev-pass]%s %s\n' "$C_WARN" "$C_RESET" "$1" >&2; }
die()  { printf '%s[link-dev-pass]%s %s\n' "$C_ERR" "$C_RESET" "$1" >&2; exit "${2:-1}"; }

# `set -a` : les valeurs servent aussi aux processus enfants (link-dev.ts lit
# LINK_DEV_EMAIL, RUNTIME_LINK_PORT, API_PORT dans son environnement).
load_env() {
  if [[ -f "$env_file" ]]; then
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
  fi
}

require() {
  command -v "$1" >/dev/null 2>&1 || die "$1 est requis."
}

valid_port() {
  [[ "$1" =~ ^[0-9]{1,5}$ ]] && (( $1 >= 1 && $1 <= 65535 ))
}

# Pas de /proc ici : ce script tourne aussi sur macOS, où il n'existe pas.
# `ps -o command=` est le seul lecteur de ligne de commande commun aux deux.
pid_matches() {
  local pid="$1" needle="$2" cmdline
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  cmdline="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$cmdline" == *"$needle"* ]]
}

read_pid() {
  local file="$1" needle="$2" pid
  [[ -f "$file" ]] || return 1
  pid="$(<"$file")"
  pid_matches "$pid" "$needle" || return 1
  printf '%s' "$pid"
}

http_ok() {
  curl --fail --silent --show-error --max-time "${2:-4}" "$1" >/dev/null 2>&1
}

# Attend qu'une condition devienne vraie, en abandonnant si le processus
# surveillé est mort entre-temps : sinon la boucle attend le délai complet pour
# annoncer un échec déjà écrit dans le journal.
wait_for() {
  local attempts="$1" pid="$2" log="$3"; shift 3
  local i
  for (( i = 0; i < attempts; i++ )); do
    if "$@"; then return 0; fi
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      [[ -f "$log" ]] && tail -n 15 "$log" >&2 || true
      return 1
    fi
    sleep 1
  done
  [[ -f "$log" ]] && tail -n 15 "$log" >&2 || true
  return 1
}

stop_pid() {
  local file="$1" needle="$2" label="$3" pid
  if ! pid="$(read_pid "$file" "$needle")"; then
    rm -f "$file"
    return 1
  fi
  kill "$pid" 2>/dev/null || true
  local i
  for (( i = 0; i < 25; i++ )); do
    pid_matches "$pid" "$needle" || break
    sleep 0.2
  done
  if pid_matches "$pid" "$needle"; then
    warn "$label ne répond pas à SIGTERM, SIGKILL."
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$file"
  # « $label arrêté » n'accorderait pas « Passerelle » : le participe reste
  # sur « processus », qui vaut pour les deux.
  say "$label : processus arrêté (pid $pid)."
  return 0
}

# ─── up ──────────────────────────────────────────────────────────────────────

cmd_up() {
  load_env
  require curl
  require bun
  require ssh

  local host="${HOST:-}"
  [[ -n "$host" ]] || die "Aucun hôte : lancez make link-dev-up HOST=user@hôte (hôte ssh de votre runtime)." 2

  # TICKET=ask : ticket ouvert dans la console (Réglages, Installation,
  # fenêtre d'appairage) au lieu du compte dev, pour que le runtime arrive
  # dans l'espace de celui qui l'a ouvert (un compte Google compris). Demandé
  # ici, au premier plan, sans écho : link-dev.ts tourne détaché, sans
  # terminal. Il passe par un fichier 0600 que link-dev.ts efface à la lecture.
  local ticket_file=""
  if [[ -n "${LINK_DEV_TICKET:-}" ]]; then
    [[ "$LINK_DEV_TICKET" == ask ]] || die "TICKET n'accepte que ask : le ticket se colle, il ne passe jamais en argument." 2
    [[ -t 0 ]] || die "TICKET=ask demande un terminal pour coller le ticket." 2
    local pasted=""
    read -r -s -p "Ticket copié depuis la console : " pasted
    echo
    [[ -n "${pasted//[[:space:]]/}" ]] || die "Ticket vide." 2
    # A paste can arrive wrapped in bracketed-paste markers (ESC[200~ ...
    # ESC[201~) or with a Windows carriage return; `read` keeps them and
    # edge-setup then refuses the ticket. Strip them and check the shape here,
    # saying what is wrong without ever printing the value.
    local esc=$'\e' hint shape='^[0-9a-fA-F-]{36}\.[A-Za-z0-9_+/=-]{16,}$'
    pasted="${pasted//"${esc}[200~"/}"
    pasted="${pasted//"${esc}[201~"/}"
    pasted="${pasted//[[:space:][:cntrl:]]/}"
    if [[ ! "$pasted" =~ $shape ]]; then
      hint="${#pasted} caractères"
      [[ "$pasted" == *.* ]] || hint+=", sans point"
      [[ "$pasted" == *edge-setup* || "$pasted" == *--* ]] && hint+=", ressemble à une commande"
      die "Ce qui a été collé n'a pas la forme d'un ticket (<id>.<secret>) : $hint. Copier le TICKET (bloc 2 de la fenêtre d'appairage), pas la commande." 2
    fi
    mkdir -p "$state_dir"
    ticket_file="$state_dir/ticket"
    ( umask 077; printf '%s\n' "$pasted" > "$ticket_file" )
    pasted=""
    # Filet si on s'arrête avant que link-dev.ts ne l'ait lu : `up` n'a rendu
    # la main qu'une fois « Tunnel ouvert » écrit, donc le fichier déjà effacé.
    trap "rm -f '$ticket_file'" EXIT
  fi

  local mode="${RUNTIME_LINK_MODE:-embedded}"
  case "$mode" in
    embedded|separate) ;;
    *) die "RUNTIME_LINK_MODE invalide : $mode." 2 ;;
  esac

  local api_port="${API_PORT:-8790}"
  local gateway_port="${RUNTIME_LINK_PORT:-8791}"
  valid_port "$api_port" || die "API_PORT invalide : $api_port." 2
  valid_port "$gateway_port" || die "RUNTIME_LINK_PORT invalide : $gateway_port." 2

  mkdir -p "$state_dir"
  chmod 700 "$state_dir" 2>/dev/null || true

  # L'API d'abord : l'enrôlement s'ouvre chez elle, et sans elle tout le reste
  # échouerait plus loin avec un message qui ne pointerait pas la cause.
  http_ok "http://127.0.0.1:$api_port/api/health" \
    || die "L'API locale ne répond pas sur 127.0.0.1:$api_port ; lancez « make dev » dans un autre terminal."

  if [[ "$mode" == "separate" ]]; then
    start_gateway "$gateway_port"
  else
    say "Mode embedded : l'API porte le lien, aucune passerelle séparée à démarrer."
  fi

  start_link "$host"
  cmd_status
}

start_gateway() {
  local port="$1" pid
  if pid="$(read_pid "$gateway_pid_file" "link-gateway/src/main.ts")"; then
    say "Passerelle de lien déjà démarrée par ce script (pid $pid, port $port)."
    return 0
  fi
  rm -f "$gateway_pid_file"

  # Un port déjà servi n'est pas forcément le nôtre : un service utilisateur ou
  # un terminal peut le tenir. On s'en sert, mais on ne l'adoptera pas au
  # `down` : ce script n'arrête que ce qu'il a lui-même lancé.
  if http_ok "http://127.0.0.1:$port/health" 2; then
    warn "Le port $port est déjà servi par un autre processus ; « down » ne l'arrêtera pas."
    return 0
  fi

  : > "$gateway_log_file"
  chmod 600 "$gateway_log_file" 2>/dev/null || true
  nohup ${detach[@]+"${detach[@]}"} bash scripts/runtime-link-launch.sh "$(command -v bun)" \
    >"$gateway_log_file" 2>&1 </dev/null &
  pid=$!
  printf '%s\n' "$pid" > "$gateway_pid_file"

  if ! wait_for 30 "$pid" "$gateway_log_file" http_ok "http://127.0.0.1:$port/health" 2; then
    kill "$pid" 2>/dev/null || true
    rm -f "$gateway_pid_file"
    die "La passerelle de lien n'a pas répondu sur 127.0.0.1:$port ; journal dans $gateway_log_file."
  fi
  say "Passerelle de lien active (pid $pid, port $port)."
}

start_link() {
  local host="$1" pid

  # L'instance et son port VPS viennent de scripts/lib/link-dev.ts (planLinkDev) :
  # par défaut le nom de ce poste, jamais `default`, qui reprendrait le lien de
  # production du VPS. Une seule source, pour que ce script, link-dev.ts et
  # `status` parlent de la même instance. Deux postes sur une même instance se
  # disputaient le même port VPS : le second bouclait sur `remote port
  # forwarding failed` pendant que le premier gardait le lien.
  local instance remote_port
  read -r instance remote_port < <(bun scripts/link-dev.ts --plan) \
    || die "Plan du lien illisible : bun scripts/link-dev.ts --plan." 2
  [[ -n "$instance" && -n "$remote_port" ]] || die "Plan du lien illisible : bun scripts/link-dev.ts --plan." 2
  say "Ce poste : instance $instance, port VPS $remote_port."
  local args=(--host "$host" --instance "$instance")
  [[ -n "${LINK_DEV_RUNTIME_NAME:-}" ]] && args+=(--runtime-name "$LINK_DEV_RUNTIME_NAME")
  [[ -n "${LINK_TUNNEL_SSH:-}" ]] && args+=(--ssh "$LINK_TUNNEL_SSH")

  # Un ticket de la console reprend l'instance même liée : le lien en cours
  # (son tunnel) est arrêté, puis relancé avec le ticket.
  if [[ -n "$ticket_file" ]]; then
    stop_pid "$link_pid_file" "link-dev.ts" "Lien" || true
    args+=(--ticket-file "$ticket_file")
  fi

  # Un processus vivant ne prouve pas un lien vivant : une VM revenue à son
  # snapshot a perdu l'instance, et le tunnel rouvre alors vers un connecteur
  # qui n'existe plus. On demande au VPS avant de réutiliser.
  if pid="$(read_pid "$link_pid_file" "link-dev.ts")"; then
    local check_code=0
    bun scripts/link-dev.ts "${args[@]}" --check >/dev/null 2>&1 || check_code=$?
    case "$check_code" in
      0)
        say "Lien déjà ouvert par ce script (pid $pid), instance $instance liée sur $host."
        return 0
        ;;
      3)
        warn "Lien ouvert (pid $pid), mais l'instance $instance n'est plus liée sur $host : relance avec un nouvel enrôlement."
        stop_pid "$link_pid_file" "link-dev.ts" "Lien" || true
        ;;
      *)
        warn "Lien ouvert (pid $pid), mais l'état de l'instance $instance sur $host est illisible : lien gardé tel quel. Pour forcer : make link-dev-down && make link-dev-up HOST=$host"
        return 0
        ;;
    esac
  fi
  rm -f "$link_pid_file"

  : > "$link_log_file"
  chmod 600 "$link_log_file" 2>/dev/null || true
  nohup ${detach[@]+"${detach[@]}"} bun scripts/link-dev.ts "${args[@]}" >"$link_log_file" 2>&1 </dev/null &
  pid=$!
  printf '%s\n' "$pid" > "$link_pid_file"

  # « Tunnel ouvert » est la dernière ligne de link-dev.ts : elle vaut à la fois
  # tunnel établi ET enrôlement terminé. L'attente couvre les 60 s pendant
  # lesquelles il sonde l'enrôlement, plus la marge du `edge-setup link`.
  if ! wait_for 120 "$pid" "$link_log_file" grep -q "Tunnel ouvert" "$link_log_file"; then
    kill "$pid" 2>/dev/null || true
    rm -f "$link_pid_file"
    die "Le lien ne s'est pas ouvert ; journal complet dans $link_log_file."
  fi
  sed -n 's/^  connector/  connector/p' "$link_log_file" || true
  say "Lien ouvert vers $host (pid $pid, instance $instance)."
}

# ─── down ────────────────────────────────────────────────────────────────────

cmd_down() {
  mkdir -p "$state_dir"
  local stopped=0
  # Le lien d'abord : il dépend de la passerelle, l'inverse n'est pas vrai.
  stop_pid "$link_pid_file" "link-dev.ts" "Lien" && stopped=1
  stop_pid "$gateway_pid_file" "link-gateway/src/main.ts" "Passerelle de lien" && stopped=1
  if (( stopped == 0 )); then
    say "Rien à arrêter : aucun processus démarré par ce script n'est vivant."
  fi
}

# ─── status ──────────────────────────────────────────────────────────────────

cmd_status() {
  load_env
  local api_port="${API_PORT:-8790}"
  local gateway_port="${RUNTIME_LINK_PORT:-8791}"
  local mode="${RUNTIME_LINK_MODE:-embedded}"
  local pid

  printf 'mode de lien       %s\n' "$mode"
  local plan_instance plan_port
  if read -r plan_instance plan_port < <(bun scripts/link-dev.ts --plan 2>/dev/null); then
    printf 'instance du poste  %s, port VPS %s\n' "$plan_instance" "$plan_port"
  fi

  if http_ok "http://127.0.0.1:$api_port/api/health" 2; then
    printf 'API :%-14s active\n' "$api_port"
  else
    printf 'API :%-14s %sabsente (make dev)%s\n' "$api_port" "$C_ERR" "$C_RESET"
  fi

  if [[ "$mode" == "separate" ]]; then
    if pid="$(read_pid "$gateway_pid_file" "link-gateway/src/main.ts")"; then
      printf 'passerelle :%-7s active, pid %s, à nous\n' "$gateway_port" "$pid"
    elif http_ok "http://127.0.0.1:$gateway_port/health" 2; then
      printf 'passerelle :%-7s active, à un autre processus\n' "$gateway_port"
    else
      printf 'passerelle :%-7s %sabsente%s\n' "$gateway_port" "$C_ERR" "$C_RESET"
    fi
  fi

  if pid="$(read_pid "$link_pid_file" "link-dev.ts")"; then
    printf 'lien               ouvert, pid %s\n' "$pid"
  else
    printf 'lien               %sfermé%s\n' "$C_ERR" "$C_RESET"
  fi

  # Le journal ssh n'a pas d'horodatage : sans son âge, une coupure passée
  # (passerelle redémarrée) se lit comme l'état actuel du lien.
  if [[ -f "$link_log_file" ]]; then
    local age written
    age=$(( $(date +%s) - $(date -r "$link_log_file" +%s) ))
    if (( age < 60 )); then written="${age} s"
    elif (( age < 3600 )); then written="$(( age / 60 )) min"
    else written="$(( age / 3600 )) h $(printf '%02d' $(( age % 3600 / 60 )))"
    fi
    printf 'dernier journal    %s (écrit il y a %s)\n' "$(tail -n 1 "$link_log_file" 2>/dev/null || true)" "$written"
  fi
  return 0
}

# ─── modes ───────────────────────────────────────────────────────────────────

# Le tableau de bord de la bascule. Relier écrase le lien de l'instance visée,
# donc la seule question qui vaut est : aujourd'hui, chaque instance de ce VPS
# vise quoi ? Une origine https est une production, une loopback est ce poste
# au bout du tunnel. `active` est l'état systemd de l'unité, pas la preuve que
# le lien est monté : un connecteur actif derrière un tunnel fermé rappelle
# dans le vide, et c'est `status` ci-dessus qui le dit.
cmd_modes() {
  load_env
  require ssh
  local host="${HOST:-}"
  [[ -n "$host" ]] || die "Aucun hôte : lancez make link-mode HOST=user@hôte." 2

  printf 'côté poste\n'
  cmd_status

  printf '\ncôté VPS (%s) : ce que chaque lien vise\n' "$host"
  local remote_status
  # Mêmes gardes que scripts/lib/ssh-remote.ts : ConnectTimeout borne la
  # poignée de main, les ServerAlive* une session ouverte qui cesse de
  # répondre. Sans eux, `make link-mode` pend au lieu de dire ce qu'il voit.
  if ! remote_status="$(ssh -o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 "$host" 'sudo -n edge-setup status' 2>&1)"; then
    warn "edge-setup status a échoué sur $host : ${remote_status}"
    return 1
  fi
  printf '%s\n' "$remote_status" | awk '
    /^connector/ {
      name = $2; active = ""; ohb = ""; runtime = "";
      for (i = 3; i <= NF; i++) {
        eq = index($i, "=");
        if (eq == 0) continue;
        key = substr($i, 1, eq - 1); value = substr($i, eq + 1);
        if (key == "active") active = value;
        else if (key == "ohb") ohb = value;
        else if (key == "runtime") runtime = value;
      }
      mode = (ohb ~ /^https:/) ? "production" : "dev (ce poste, par le tunnel)";
      state = (active == "true") ? "unité active" : "unité arrêtée";
      printf "  %-9s %-30s %-14s %s\n", name, mode, state, ohb;
      if (runtime != "") printf "  %-9s runtime %s\n", "", runtime;
    }'

  printf '\nbasculer ce VPS (relier écrase le lien de l'"'"'instance visée)\n'
  printf '  dev   make link-dev-up HOST=%s\n' "$host"
  printf '  prod  make link-prod    HOST=%s\n' "$host"
  printf '  une seule instance qui bascule : LINK_DEV_INSTANCE=default\n'
}

# ─── verify ──────────────────────────────────────────────────────────────────

verify_chrome_pid=''
verify_profile_dir=''

# Le Chrome de la passe ne survit jamais à la passe, succès ou échec : il tient
# un port et un profil, et un second passage retomberait dessus.
cleanup_verify() {
  local code=$? i
  if [[ -n "${verify_chrome_pid:-}" ]]; then
    kill "$verify_chrome_pid" 2>/dev/null || true
    # Chrome écrit encore dans son profil quand il reçoit le TERM : effacer
    # tout de suite laissait un `Directory not empty` qui faisait échouer une
    # passe pourtant verte.
    for (( i = 0; i < 25; i++ )); do
      kill -0 "$verify_chrome_pid" 2>/dev/null || break
      sleep 0.2
    done
    kill -KILL "$verify_chrome_pid" 2>/dev/null || true
  fi
  if [[ -n "${verify_profile_dir:-}" ]]; then rm -rf "$verify_profile_dir" 2>/dev/null || true; fi
  return "$code"
}


# Preuve navigateur, à la demande seulement. Un Chrome jetable, son propre
# profil, piloté par CDP : celui de l'opérateur n'est ni ouvert ni touché, et
# aucune dépendance n'est installée pour ça.
cmd_verify() {
  load_env
  require curl

  local chrome="${CHROME_BIN:-}"
  if [[ -z "$chrome" ]]; then
    local candidate
    for candidate in \
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      "/Applications/Chromium.app/Contents/MacOS/Chromium" \
      google-chrome chromium chromium-browser; do
      if [[ -x "$candidate" ]] || command -v "$candidate" >/dev/null 2>&1; then
        chrome="$candidate"; break
      fi
    done
  fi
  [[ -n "$chrome" ]] || die "Chrome introuvable ; passez CHROME_BIN=/chemin/chrome."

  local api_port="${API_PORT:-8790}"
  http_ok "http://127.0.0.1:$api_port/api/health" \
    || die "L'API locale ne répond pas sur 127.0.0.1:$api_port ; lancez « make dev »."

  local cdp_port="${LINK_DEV_VERIFY_PORT:-9333}"
  valid_port "$cdp_port" || die "LINK_DEV_VERIFY_PORT invalide : $cdp_port." 2

  # Globales, pas des locales : le piège EXIT s'exécute une fois `cmd_verify`
  # sortie, quand une locale n'existe plus et que `set -u` ferait échouer le
  # nettoyage après une passe pourtant réussie.
  verify_profile_dir="$state_dir/verify-profile"
  local chrome_log="$state_dir/verify-chrome.log"
  mkdir -p "$state_dir"
  rm -rf "$verify_profile_dir"
  trap cleanup_verify EXIT

  "$chrome" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
    --remote-debugging-port="$cdp_port" --user-data-dir="$verify_profile_dir" \
    --window-size=1440,900 about:blank >"$chrome_log" 2>&1 &
  verify_chrome_pid=$!

  if ! wait_for 20 "$verify_chrome_pid" "$chrome_log" http_ok "http://127.0.0.1:$cdp_port/json/version" 2; then
    die "Chrome n'a pas ouvert son port CDP $cdp_port ; journal dans $chrome_log."
  fi

  LINK_DEV_VERIFY_PORT="$cdp_port" \
  LINK_DEV_VERIFY_OUT="${LINK_DEV_VERIFY_OUT:-tmp/runtime-settings-pass}" \
    bun apps/console/scripts/runtime-settings-pass.ts
}

case "$action" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  modes) cmd_modes ;;
  verify) cmd_verify ;;
  *) die "usage: $0 {up|down|status|modes|verify}" 2 ;;
esac
