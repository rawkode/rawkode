#!/usr/bin/env sh
if [[ \$(ps --no-header --pid=\$PPID --format=comm) != "nu" && -z \${BASH_EXECUTION_STRING} && \${SHLVL} == 1 ]]
then
	shopt -q login_shell && LOGIN_OPTION='--login' || LOGIN_OPTION=''
	exec nu \$LOGIN_OPTION
fi
