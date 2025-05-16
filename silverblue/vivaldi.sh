#!/usr/bin/env bash
set -eoux pipefail

cat <<EOF >/etc/yum.repos.d/vivaldi.repo
[vivaldi]
name=vivaldi
type=rpm
baseurl=http://repo.vivaldi.com/archive/rpm/x86_64
enabled=1
gpgcheck=1
gpgkey=http://repo.vivaldi.com/archive/linux_signing_key.pub
EOF

rpm --import http://repo.vivaldi.com/archive/linux_signing_key.pub

rpm-ostree install vivaldi

mv /var/opt/vivaldi-snapshot /usr/lib/vivaldi-snapshot
rm /usr/bin/vivaldi-snapshot
ln -s /usr/lib/vivaldi-snapshot/vivaldi-snapshot /usr/bin/vivaldi-snapshot

mkdir -p  /etc/1password
echo <<EOF >>/etc/1password/custom_allowed_browsers
vivaldi
vivaldi-bin
vivaldi-snapshot
EOF

rm -f /etc/yum.repos.d/vivaldi.repo
