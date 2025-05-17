def --env ghb [group?: string, repository?: string] {
    let path = $nu.home-path;
    cd $"($nu.home-path)/Code/src/github.com/($group)/($repository)"
};


def --env rkc [group?: string, repository?: string] {
    cd $"($nu.home-path)/Code/src/code.rawkode.academy/($group)/($repository)"
};
