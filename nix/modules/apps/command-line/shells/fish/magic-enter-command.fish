set -l cmd ls

# Check if we're in a git repo (without spawning a new fish shell)
if git rev-parse --is-inside-work-tree >/dev/null 2>&1
    set cmd git status --short
end

echo $cmd
