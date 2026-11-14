#!/usr/bin/env bash
# Full `up` in a throwaway Debian 13 VM (QEMU + cloud-init): the only place
# rootless docker and cgroup delegation can be proven. A new admin SSH
# session is checked, but this runner does not reboot or link to openedbot.
# Requires: qemu-system-x86_64, genisoimage (or cloud-localds), curl, ssh.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd -P)"
work="${EDGE_SETUP_VM_DIR:-$root/tmp/vm}"
image_url="${EDGE_SETUP_VM_IMAGE:-https://cloud.debian.org/images/cloud/trixie/latest/debian-13-generic-amd64.qcow2}"
ssh_port="${EDGE_SETUP_VM_SSH_PORT:-2222}"
mem="${EDGE_SETUP_VM_MEM:-4096}"
cpus="${EDGE_SETUP_VM_CPUS:-2}"

mkdir -p "$work"
cd "$work"
[[ -f base.qcow2 ]] || curl -fsSL "$image_url" -o base.qcow2
rm -f disk.qcow2
qemu-img create -q -f qcow2 -b base.qcow2 -F qcow2 disk.qcow2 20G
[[ -f id_ed25519 ]] || ssh-keygen -q -t ed25519 -N '' -f id_ed25519
[[ -f admin_ed25519 ]] || ssh-keygen -q -t ed25519 -N '' -f admin_ed25519
cat > user-data <<EOF
#cloud-config
users:
  - name: debian
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: true
    ssh_authorized_keys:
      - $(cat id_ed25519.pub)
EOF
printf 'instance-id: edge-setup-vm\nlocal-hostname: hermes-vm\n' > meta-data
if command -v cloud-localds >/dev/null; then cloud-localds seed.iso user-data meta-data
else genisoimage -quiet -output seed.iso -volid cidata -joliet -rock user-data meta-data; fi

qemu-system-x86_64 -machine accel=kvm:tcg -cpu host -m "$mem" -smp "$cpus" -nographic -display none \
  -drive file=disk.qcow2,if=virtio -drive file=seed.iso,if=virtio,format=raw \
  -netdev user,id=n0,hostfwd=tcp::"$ssh_port"-:22 -device virtio-net-pci,netdev=n0 \
  -serial file:serial.log -pidfile qemu.pid -daemonize
trap 'kill "$(cat qemu.pid)" 2>/dev/null || true' EXIT

ssh_opts=(-i id_ed25519 -p "$ssh_port" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o LogLevel=ERROR)
for _ in $(seq 1 90); do ssh "${ssh_opts[@]}" debian@127.0.0.1 true 2>/dev/null && break; sleep 2; done
ssh "${ssh_opts[@]}" debian@127.0.0.1 true || { echo "VM did not come up (see $work/serial.log)" >&2; exit 1; }

# hermes-admin's sudo password (the default --admin-sudo=password); the VM has
# no terminal for the prompt, so it comes from a 0600 file.
admin_password="vm-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
(umask 077; printf '%s\n' "$admin_password" > admin.password)
scp -q "${ssh_opts[@]}" "$root/dist/edge-setup" admin_ed25519.pub admin.password debian@127.0.0.1:/tmp/
# The command line is built here, on purpose, and run by the VM's shell.
# shellcheck disable=SC2029
vm() { ssh "${ssh_opts[@]}" debian@127.0.0.1 "sudo -n $*"; }
vm install -m 0755 /tmp/edge-setup /usr/local/sbin/edge-setup
vm install -m 0600 /tmp/admin_ed25519.pub /root/admin.pub
vm install -m 0600 /tmp/admin.password /root/admin.password
vm rm -f /tmp/admin.password
vm edge-setup detect
vm edge-setup up --sandbox --persistent-journal --unattended-upgrades \
  --sudo-logging --password-policy --disable-llmnr \
  --firewall --allow-inbound 22/tcp --fail2ban \
  --ssh-hardening --quarantine-cloud-user \
  --admin-key /root/admin.pub --admin-password-file /root/admin.password \
  --console-confirmed --detach --yes
# The new session: the admin key over the forwarded port; sudo reads the
# password on stdin.
admin() { ssh -i admin_ed25519 -p "$ssh_port" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR hermes-admin@127.0.0.1 "sudo -S -p '' $*" < admin.password; }
admin edge-setup verify-access
admin rm -f /root/admin.password
admin edge-setup doctor
admin edge-setup audit --strict
admin edge-setup status
# Rootless docker and the sandbox really ran: a container proved its cgroup limits.
admin "runuser -u hermes -- env XDG_RUNTIME_DIR=/run/user/\$(id -u hermes) DOCKER_HOST=unix:///run/user/\$(id -u hermes)/docker.sock docker info --format '{{.SecurityOptions}}' | grep -q rootless"
admin edge-setup reset --yes --purge-data --i-understand-data-loss --purge-packages
echo "VM scenario passed"
