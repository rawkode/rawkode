#!/usr/bin/env bash

# Update Zellij config to use light theme
# Zellij doesn't support runtime theme switching, so we need to update the config file
sed -i 's/theme "catppuccin-macchiato"/theme "catppuccin-latte"/' "$HOME/.config/zellij/config.kdl"
