# Favourites
# bespin, brewer, bright, chalk, dracula, eighties, gnome-dark, gruvbox-dark, monokao, nord, seti, tomorrow-night
zplug "chriskempson/base16-shell", use:"scripts/base16-brewer.sh"

## Can't decide if these are useful or annoying
# zplug "rawkode/zsh-docker-run"
# zplug "rawkode/zsh-gcloud-context-switcher", from:gitlab
# zplug "rawkode/zsh-kubectl-context-switcher", from:gitlab

zplug "zsh-users/zsh-autosuggestions"
zplug "zsh-users/zsh-completions"
zplug "zsh-users/zsh-history-substring-search"
zplug "zsh-users/zsh-syntax-highlighting"

zplug "plugins/command-not-found",      from:oh-my-zsh
zplug "plugins/colored-man-pages",      from:oh-my-zsh
#zplug "plugins/colorize",               from:oh-my-zsh
zplug "plugins/docker",                 from:oh-my-zsh, if:"(( $+commands[docker] ))"
zplug "plugins/docker-compose",         from:oh-my-zsh, if:"(( $+commands[docker-compose] ))"
zplug "plugins/dotenv",                 from:oh-my-zsh
zplug "plugins/gpg-agent",              from:oh-my-zsh
zplug "plugins/kubectl",                from:oh-my-zsh
zplug "plugins/per-directory-history",  from:oh-my-zsh
zplug "plugins/sudo",                   from:oh-my-zsh
#zplug "plugins/z",                      from:oh-my-zsh

#zplug 'b4b4r07/enhancd', use:'init.sh'
#zplug 'b4b4r07/cli-finder', as:command, use:'bin/finder'
#zplug 'b4b4r07/easy-oneliner', on:'junegunn/fzf-bin'
#zplug 'b4b4r07/emoji-cli', on:'stedolan/jq'
zplug "b4b4r07/git-conflict", as:command, use:'git-conflict'

zplug 'stedolan/jq', from:gh-r, as:command
#zplug "mrowa44/emojify", as:command

#zplug 'direnv/direnv', as:command, from:gh-r, rename-to:direnv
#if (( $+commands[direnv] )); then eval "$(direnv hook zsh)"; fi

zplug 'desyncr/auto-ls'
zplug "hlissner/zsh-autopair", defer:2
zplug "Valiev/almostontop"

zplug "junegunn/fzf", use:"shell/*.zsh", as:plugin

#zplug mafredri/zsh-async, from:github
#zplug sindresorhus/pure, use:pure.zsh, from:github, as:theme
#zplug "themes/agnoster", from:oh-my-zsh, as:theme
#zplug "eendroroy/alien"
#zplug "geometry-zsh/geometry"
#zplug denysdovhan/spaceship-prompt, use:spaceship.zsh, from:github, as:theme
zplug "bhilburn/powerlevel9k", use:powerlevel9k.zsh-theme

# Install plugins if there are plugins that have not been installed
if ! zplug check --verbose; then
    printf "Install? [y/N]: "
    if read -q; then
        echo; zplug install
    fi
fi

# Then, source plugins and add commands to $PATH
zplug load
