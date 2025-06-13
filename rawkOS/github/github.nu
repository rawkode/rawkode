def --env ghb [group?: string, repository?: string] {
  let path = $nu.home-path;
  cd $"($nu.home-path)/Code/src/github.com/($group)/($repository)"
};

def ghce [...command] {
	gh copilot explain ...$command
}

def ghcs [...question] {
	gh copilot suggest ...$question
}
