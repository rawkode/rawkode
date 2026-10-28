let excluded = "coreweave"
let minimum_age = 72hr

if not ("flake.lock" | path exists) {
	print "flake.lock is missing."
	print "Restore it first so excluded/private inputs stay pinned:"
	print "  git restore flake.lock"
	exit 1
}

let initial_lock = (open --raw flake.lock | from json)
let root_node = ($initial_lock | get root)
let root_inputs = ($initial_lock.nodes | get $root_node | get inputs)
let inputs = (
	$root_inputs
	| columns
	| where {|input| $input != $excluded }
)

let cutoff = ((date now | date to-timezone UTC) - $minimum_age)
let cutoff_timestamp = ($cutoff | format date "%Y-%m-%dT%H:%M:%SZ")
let cutoff_epoch = (($cutoff | into int) / 1_000_000_000 | math floor)

for input in $inputs {
	let lock = (open --raw flake.lock | from json)
	let root_node = ($lock | get root)
	let root_inputs = ($lock.nodes | get $root_node | get inputs)
	let node_id = ($root_inputs | get $input)

	if (($node_id | describe) != "string") {
		print $"Skipping ($input): it does not resolve to a single lock node."
		continue
	}

	let node = ($lock.nodes | get $node_id)
	let current_modified = ($node | get -o locked.lastModified)
	if (($current_modified | describe) != "nothing") and $current_modified > $cutoff_epoch {
		print $"Skipping ($input): its locked commit is newer than the 72-hour cutoff."
		continue
	}

	let original = ($node | get -o original)
	if (($original | describe) == "nothing") {
		print $"Skipping ($input): its original flake reference is missing."
		continue
	}

	let source_type = ($original | get -o type | default "")
	if $source_type != "github" {
		print $"Skipping ($input): only GitHub commit inputs can use the 72-hour cutoff."
		continue
	}

	let host = ($original | get -o host | default "github.com")
	if $host != "github.com" {
		print $"Skipping ($input): GitHub Enterprise host ($host) is not supported by this task."
		continue
	}

	let owner = ($original | get -o owner | default "")
	let repo = ($original | get -o repo | default "")
	let ref = ($original | get -o ref | default "")
	let explicit_rev = ($original | get -o rev)

	if $owner == "" or $repo == "" {
		print $"Skipping ($input): its GitHub owner or repository is missing."
		continue
	}

	if (($explicit_rev | describe) != "nothing") {
		print $"Skipping ($input): its flake.nix reference is already pinned to a revision."
		continue
	}

	if $ref != "" {
		let encoded_ref = ($ref | url encode --all)
		let branch_endpoint = $"repos/($owner)/($repo)/git/ref/heads/($encoded_ref)"
		let branch_result = (^gh api $branch_endpoint | complete)

		if $branch_result.exit_code != 0 {
			let tag_endpoint = $"repos/($owner)/($repo)/git/ref/tags/($encoded_ref)"
			let tag_result = (^gh api $tag_endpoint | complete)

			if $tag_result.exit_code == 0 {
				print $"Skipping ($input): ($ref) is a fixed Git tag."
				continue
			}

			error make {
				msg: $"Could not resolve ($owner)/($repo)/($ref) as a GitHub branch or tag. ($tag_result.stderr)"
			}
		}
	}

	let commits_endpoint = $"repos/($owner)/($repo)/commits"
	let commits_result = if $ref == "" {
		^gh api --method GET $commits_endpoint --field $"until=($cutoff_timestamp)" --field "per_page=1" --jq '.[0] // empty | [.sha, .commit.committer.date] | @tsv' | complete
	} else {
		^gh api --method GET $commits_endpoint --field $"sha=($ref)" --field $"until=($cutoff_timestamp)" --field "per_page=1" --jq '.[0] // empty | [.sha, .commit.committer.date] | @tsv' | complete
	}

	if $commits_result.exit_code != 0 {
		error make {
			msg: $"GitHub commit lookup failed for ($owner)/($repo) at cutoff ($cutoff_timestamp). ($commits_result.stderr)"
		}
	}

	let commit_line = ($commits_result.stdout | str trim)
	if $commit_line == "" {
		print $"Skipping ($input): no commit was found at or before ($cutoff_timestamp)."
		continue
	}

	let commit_fields = ($commit_line | split row "\t")
	let revision = ($commit_fields | first)
	let committed_at = ($commit_fields | last)
	let committed_epoch = (((($committed_at | into datetime) | into int) / 1_000_000_000) | math floor)

	if $committed_epoch > $cutoff_epoch {
		print $"Skipping ($input): GitHub returned a commit newer than the 72-hour cutoff."
		continue
	}

	let resolved_url = $"github:($owner)/($repo)/($revision)"
	let candidate_path = (^mktemp -t cuenv-flake-lock.XXXXXXXXXX | str trim)
	let update_result = (
		^nix flake update
			--output-lock-file $candidate_path
			--override-input $input $resolved_url
			$input
		| complete
	)

	if $update_result.stderr != "" {
		print $update_result.stderr
	}

	if $update_result.exit_code != 0 {
		^rm -f $candidate_path
		error make {
			msg: $"Nix failed to stage the 72-hour update for ($input)."
		}
	}

	let candidate_lock = (open --raw $candidate_path | from json)
	let candidate_root = ($candidate_lock.nodes | get $candidate_lock.root)
	let candidate_node_id = ($candidate_root.inputs | get $input)
	let candidate_node = ($candidate_lock.nodes | get $candidate_node_id)
	let selected = ($candidate_node | get locked)
	let selected_revision = ($selected | get rev)
	let selected_modified = ($selected | get -o lastModified)

	if $selected_revision != $revision {
		^rm -f $candidate_path
		error make {
			msg: $"Nix selected ($selected_revision) for ($input), but the requested cutoff revision was ($revision)."
		}
	}

	if (($selected_modified | describe) == "nothing") or $selected_modified > $cutoff_epoch {
		^rm -f $candidate_path
		print $"Skipping ($input): Nix could not confirm that ($revision) is at least 72 hours old."
		continue
	}

	let current_revisions = (
		$lock.nodes
		| values
		| each {|existing_node| $existing_node | get -o locked.rev }
		| compact
	)
	mut too_new = []
	for candidate_node in ($candidate_lock.nodes | values) {
		let locked = ($candidate_node | get -o locked)
		if (($locked | describe) == "nothing") {
			continue
		}

		let candidate_revision = ($locked | get -o rev)
		if (($candidate_revision | describe) == "nothing") {
			continue
		}

		let already_locked = ($current_revisions | any {|existing_revision| $existing_revision == $candidate_revision })
		if $already_locked {
			continue
		}

		let last_modified = ($locked | get -o lastModified)
		if (($last_modified | describe) == "nothing") or $last_modified > $cutoff_epoch {
			$too_new = ($too_new | append $candidate_revision)
		}
	}

	if not ($too_new | is-empty) {
		^rm -f $candidate_path
		print $"Skipping ($input): its candidate lock introduces revisions without a confirmed 72-hour age: ($too_new | str join ", ")"
		continue
	}

	^mv -f $candidate_path flake.lock
	print $"Updated ($input) to ($revision), committed ($committed_at)."
}
