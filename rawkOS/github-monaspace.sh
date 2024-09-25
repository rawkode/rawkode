#!/usr/bin/env bash
set -eoux pipefail

git clone https://github.com/githubnext/monaspace
cd monaspace
bash ./util/install_linux.sh
