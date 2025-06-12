#!/usr/bin/env bash

# Create fish color scheme file for light mode
mkdir -p "$HOME/.config/fish/conf.d"

cat > "$HOME/.config/fish/conf.d/catppuccin_colors.fish" << 'EOF'
# Catppuccin Latte theme for fish
set -U fish_color_normal 4c4f69
set -U fish_color_command 1e66f5
set -U fish_color_param dd7878
set -U fish_color_keyword d20f39
set -U fish_color_quote 40a02b
set -U fish_color_redirection ea76cb
set -U fish_color_end fe640b
set -U fish_color_comment 9ca0b0
set -U fish_color_error d20f39
set -U fish_color_gray 9ca0b0
set -U fish_color_selection --background=ccd0da
set -U fish_color_search_match --background=ccd0da
set -U fish_color_option 40a02b
set -U fish_color_operator ea76cb
set -U fish_color_escape dc8a78
set -U fish_color_autosuggestion 9ca0b0
set -U fish_color_cancel d20f39
set -U fish_color_cwd df8e1d
set -U fish_color_user 179299
set -U fish_color_host 1e66f5
set -U fish_color_host_remote 7287fd
set -U fish_color_status d20f39
set -U fish_pager_color_progress 9ca0b0
set -U fish_pager_color_prefix ea76cb
set -U fish_pager_color_completion 4c4f69
set -U fish_pager_color_description 9ca0b0
EOF

# Update LS_COLORS for light mode
fish -c "set -Ux LS_COLORS (vivid generate catppuccin-latte)"