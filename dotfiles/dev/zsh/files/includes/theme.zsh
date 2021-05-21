BASE16_THEME='helios'

zinit ice atload"base16_${BASE16_THEME}"
zinit light "chriskempson/base16-shell"
zinit ice lucid wait'0' \
    src"bash/base16-${BASE16_THEME}.config" \
    pick"bash/base16-${BASE16_THEME}.config" nocompile'!'


# zinit light "dracula/zsh"
