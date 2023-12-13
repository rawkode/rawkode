{ pkgs, ... }: {
	programs.starship = {
		enable = true;
		enableNushellIntegration = true;
		settings = {
			add_newline = false;

			format = pkgs.lib.strings.concatStrings [
				"$username"
				"$hostname"
				"$os"
				"$directory"
				"$container"
				"$git_branch $git_status"
				"$cmd_duration"
				"$line_break"
				"$status"
				"$character"
			];
		};
	};
}
