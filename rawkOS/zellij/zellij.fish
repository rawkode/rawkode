set -fx ZELLIJ_AUTO_EXIT true
set -gx ZELLIJ_AUTO_ATTACH false

if status is-interactive
    eval (zellij setup --generate-auto-start fish | string collect)
end
