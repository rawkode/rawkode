{ pkgs, ... }: {
	home.packages = with pkgs; [
		cue
	];
}

