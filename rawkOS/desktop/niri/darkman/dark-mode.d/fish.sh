#!/usr/bin/env bash

# Create fish color scheme file for dark mode
mkdir -p "$HOME/.config/fish/conf.d"

cat > "$HOME/.config/fish/conf.d/catppuccin_colors.fish" << 'EOF'
# Catppuccin Mocha theme for fish
set -U fish_color_normal cdd6f4
set -U fish_color_command 89b4fa
set -U fish_color_param f2cdcd
set -U fish_color_keyword f38ba8
set -U fish_color_quote a6e3a1
set -U fish_color_redirection f5c2e7
set -U fish_color_end fab387
set -U fish_color_comment 6c7086
set -U fish_color_error f38ba8
set -U fish_color_gray 6c7086
set -U fish_color_selection --background=313244
set -U fish_color_search_match --background=313244
set -U fish_color_option a6e3a1
set -U fish_color_operator f5c2e7
set -U fish_color_escape eba0ac
set -U fish_color_autosuggestion 6c7086
set -U fish_color_cancel f38ba8
set -U fish_color_cwd f9e2af
set -U fish_color_user 94e2d5
set -U fish_color_host 89b4fa
set -U fish_color_host_remote b4befe
set -U fish_color_status f38ba8
set -U fish_pager_color_progress 6c7086
set -U fish_pager_color_prefix f5c2e7
set -U fish_pager_color_completion cdd6f4
set -U fish_pager_color_description 6c7086
EOF

# Update LS_COLORS for dark mode
fish -c "set -Ux LS_COLORS (vivid generate catppuccin-mocha)"