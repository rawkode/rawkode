#!/usr/bin/env bash
set -eoux pipefail

rpm-ostree install fish

# Changing my default shell to fish means that GNOME
# doesn't get updated with the paths I need for nix
# So let's set up bash to invoke fish for interactive
# sessions.
cat <<EOF > /etc/profile.d/fish.sh
if [[ $(ps --no-header --pid=\$PPID --format=comm) != "fish" && -z \${BASH_EXECUTION_STRING} && \${SHLVL} == 1 ]]
then
	shopt -q login_shell && LOGIN_OPTION='--login' || LOGIN_OPTION=''
	exec fish \$LOGIN_OPTION
fi
EOF
