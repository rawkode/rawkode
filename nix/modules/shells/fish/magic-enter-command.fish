set -l cmd ls

# Check if we're in a jj repo first, then fall back to git
if jj root >/dev/null 2>&1
    set cmd jj status
else if git rev-parse --is-inside-work-tree >/dev/null 2>&1
    set cmd git status --short
end

echo $cmd
