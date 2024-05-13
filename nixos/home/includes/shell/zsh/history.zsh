export HISTFILE=~/.zsh_history
export HISTSIZE=2048
export SAVEHIST=2048
export HISTIGNORE="&:ls:[bf]g:exit:reset:clear:cd:cd ..:cd..:zh"

# Commands that begin with a space are not added to history
setopt HIST_IGNORE_SPACE

# Remove superfluous blanks from each command line being added
# to the history list.
setopt HIST_REDUCE_BLANKS

# If a new command line being added to the history list
# duplicates an older one, the older command is removed from the
# list (even if it is not the previous event).
setopt HIST_IGNORE_ALL_DUPS

# Don't add duplicate commands to history
setopt HIST_IGNORE_DUPS

# When searching history, avoid duplicates
setopt HIST_FIND_NO_DUPS

# Write history, incrementally, as it happens; rather than
# waiting for the shell to exit
setopt INC_APPEND_HISTORY

# This allows a command executed in one shell, available in the
# history of another active shell
setopt SHARE_HISTORY

export HISTORY_IGNORE="(ls|pwd|exit)"
