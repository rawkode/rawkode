#!/usr/bin/env bash
set -eoux pipefail

# https://bugzilla.redhat.com/show_bug.cgi?id=2274331
echo <<EOF >/etc/udev/rules.d/30-amdgpu-pm.rules
KERNEL=="card0", SUBSYSTEM=="drm", DRIVERS=="amdgpu", ATTR{device/power_dpm_force_performance_level}="high"
KERNEL=="card1", SUBSYSTEM=="drm", DRIVERS=="amdgpu", ATTR{device/power_dpm_force_performance_level}="high"
EOF
