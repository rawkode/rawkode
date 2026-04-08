# Check if we're in a jj repo first, then fall back to git
echo

if jj root >/dev/null 2>&1
    eza
    echo
    jj status
else if git rev-parse --is-inside-work-tree >/dev/null 2>&1
    eza
    echo
    git status --short
else
    eza
end
