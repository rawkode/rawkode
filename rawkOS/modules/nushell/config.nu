# nushell main configuration
# See: https://www.nushell.sh/book/configuration.html

$env.config = {
  show_banner: false

  ls: {
    use_ls_colors: true
    clickable_links: true
  }

  rm: {
    always_trash: true
  }
}

# Source auto-ls script
source ~/.config/nushell/scripts/auto-ls.nu

# Shell aliases
alias ai = GEMINI_API_KEY="op://Private/Google Gemini/password" op run --account my.1password.eu -- aichat
alias ghb = cd ~/Code/src/github.com
