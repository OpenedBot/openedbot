# Debian 13 with systemd, sshd and sudo: the closest thing to a fresh VPS a
# container can offer. Rootless docker and cgroup delegation need a VM.
# BASE_IMAGE swaps the distribution for the minimal runtime scenarios
# (debian:bookworm, ubuntu:24.04); hardening scenarios stay on trixie.
ARG BASE_IMAGE=debian:trixie
FROM ${BASE_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus openssh-server openssh-client sudo ca-certificates curl gnupg iproute2 procps \
      && rm -rf /var/lib/apt/lists/* \
      && mkdir -p /run/sshd \
      && systemctl enable ssh
# The cloud-init account every Debian cloud image ships, as the tool expects.
RUN useradd --create-home --shell /bin/bash debian \
      && passwd -l debian \
      && install -d -o debian -g debian -m 0700 /home/debian/.ssh \
      && ssh-keygen -q -t ed25519 -N "" -f /tmp/cloudkey \
      && install -o debian -g debian -m 0600 /tmp/cloudkey.pub /home/debian/.ssh/authorized_keys \
      && rm -f /tmp/cloudkey /tmp/cloudkey.pub \
      && printf 'debian ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/90-cloud-init-users \
      && chmod 0440 /etc/sudoers.d/90-cloud-init-users
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
