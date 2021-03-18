##
# Always Clear Screen & Run `ls`
##
AUTO_LS_COMMANDS=(exa git-status)

zinit ice lucid pick"auto-ls.zsh"
zinit load "desyncr/auto-ls"

auto-ls-exa () {
  exa -l
  [[ $AUTO_LS_NEWLINE != false ]] && echo ""
}

# Temp Sandbox
alias tmp='cd $(mktemp -d)'

