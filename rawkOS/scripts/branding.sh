#!/usr/bin/bash
set -ouex pipefail

sed -i '/^PRETTY_NAME/s/Silverblue/rawkOS/' /usr/lib/os-release
sed -i 's/Bluefin/rawkOS/g' /usr/etc/yafti.yml
sed -i 's/Aurora (Beta)/rawkOS/' /usr/etc/yafti.yml
sed -i 's/Bluefin/rawkOS/' /usr/libexec/ublue-flatpak-manager
