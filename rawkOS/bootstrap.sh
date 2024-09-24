#!/usr/bin/env bash
set -eoux pipefail

# Alternatives needs this symlink to work during a container build
ln -sf /usr/bin/ld.bfd /etc/alternatives/ld && ln -sf /etc/alternatives/ld /usr/bin/ld
