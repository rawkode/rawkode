# carapace shell integration for nushell
# Initialize carapace completions

if (which carapace | length) > 0 {
    carapace _carapace nushell | save -f ~/.cache/carapace/init.nu
    source ~/.cache/carapace/init.nu
}
