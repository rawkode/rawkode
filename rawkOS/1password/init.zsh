# 1Password op plugin init for zsh
if command -v op >/dev/null 2>&1; then
  eval "$(op plugin init zsh)"
fi
