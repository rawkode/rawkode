$env.PATH = ($env.PATH | split row (char esep) | append $"($env.HOME)/Code/bin")
