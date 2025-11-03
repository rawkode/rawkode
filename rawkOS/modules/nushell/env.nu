# nushell environment configuration
# See: https://www.nushell.sh/book/configuration.html

# Environment variables
$env.OP_PLUGIN_ALIASES_SOURCED = "1"
$env.SSH_AUTH_SOCK = ($env.HOME | path join '1password' 'agent.sock')

# PATH configuration
# Note: Adjust these paths based on your system configuration
# $env.PATH = ($env.PATH | split row (char esep) | prepend $'($env.HOME)/.nix-profile/bin')
