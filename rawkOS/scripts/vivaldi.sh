#!/usr/bin/bash
set -ouex pipefail

mv /var/opt/vivaldi-snapshot /usr/lib/vivaldi-snapshot

rm /usr/bin/vivaldi-snapshot
ln -s /usr/lib/vivaldi-snapshot/vivaldi-snapshot /usr/bin/vivaldi-snapshot