# cd
alias cd=' cd'

# ls
alias tree=' exa --long --tree --level=2'
alias treee=' exa --long --tree --level=3'
alias treee=' exa --long --tree --level=4'
alias treeee=' exa --long --tree --level=5'
alias treeeee=' exa --long --tree --level=6'
alias ls=' exa --git'
alias ll=' exa --git -l'

# Development Aliases
alias dc='docker-compose'
alias dcr='docker-compose run --rm'

# Arch
alias pacman=' yay --color=always'
alias pacmanc=' yay -Rns $(pacman -Qtdq)'
alias yayc=' yay -Yc'

# Git
alias git=' git'

# Kubernetes
alias k='kubectl'
alias ka='kubectl apply'
alias kp='kubectl get pods'
alias kd='kubectl get deploy'
alias kl='kubectl logs'
alias kcx='kubectl config get-contexts'
alias ksx='kubectl config use-context'

# Development aliases
alias src=' cd $HOME/Code/src/'
alias box=' cd $HOME/Code/sandbox/'

# Fuck typing xdg-open
alias open=' xdg-open'

## Visual Studio Code Adoption
alias vi=' code'
alias vim=' code'
alias nvim=' code'
