#!/usr/bin/env bash
set -eoux pipefail

cd /tmp

git clone https://github.com/githubnext/monaspace

cd monaspace

mkdir -p /usr/share/fonts/Monaspace/

cp ./fonts/otf/* /usr/share/fonts/Monaspace/
cp ./fonts/variable/* /usr/share/fonts/Monaspace/

fc-cache --system-only --really-force /usr/share/fonts/Monaspace/

rm -rf /tmp/monaspace
