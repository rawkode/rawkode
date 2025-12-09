# cuenv shell integration for fish
# Initialize cuenv environment manager

if type -q cuenv
    cuenv shell init fish | source
    cuenv completions fish | source
end
