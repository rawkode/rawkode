eza

if jj root >/dev/null 2>&1
    echo && jj status --no-pager
else if git rev-parse --is-inside-work-tree >/dev/null 2>&1
    echo && git -c color.status=always status --short
end
