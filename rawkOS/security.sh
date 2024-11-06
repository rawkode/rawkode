#!/usr/bin/env bash
set -eoux pipefail

rpm-ostree install clevis clevis-luks clevis-dracut clevis-udisks2 clevis-systemd
