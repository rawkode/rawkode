#
bindkey '^[[A' history-substring-search-up
bindkey '^[[B' history-substring-search-down

# Rebind HOME and END to do the decent thing:
bindkey '\e[1~' beginning-of-line
bindkey '\e[4~' end-of-line

# Control <- and Control ->
bindkey '\e[1;9C' forward-word
bindkey '\e[1;9D' backward-word

case $TERM in (xterm*)
 bindkey '\e[H' beginning-of-line
 bindkey '\e[F' end-of-line
esac

# And DEL too, as well as PGDN and insert:
bindkey '\e[3~' delete-char
bindkey '\e[6~' end-of-history
bindkey '\e[2~' redisplay

