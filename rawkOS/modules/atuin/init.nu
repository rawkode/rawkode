# atuin shell integration for nushell
# Initialize atuin for nushell

# Run atuin init for nushell
if (which atuin | length) > 0 {
    atuin init nu | save -f ~/.cache/atuin/init.nu
    source ~/.cache/atuin/init.nu
}
