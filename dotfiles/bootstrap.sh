#!/usr/bin/env sh
set -eox pipefail

# Do we have Homebrew?
if [ ! command -v comtrya >/dev/null 2>&1 ]
then
	echo "Installing Homebrew ..."
	curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | bash
fi

# Do we have Comtrya?
if [ ! command -v comtrya >/dev/null 2>&1 ]
then
	echo "Installing Rust ..."
	curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
	echo "Installing Comtrya ..."
	${HOME}/.cargo/bin/cargo install comtrya
fi

# Check if we're in a GitHub Codespaces environment
if [ ! -z "${CODESPACES}" ]
then
	sudo apt update && sudo apt install build-essential gcc
	(echo; echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"') >> /home/codespace/.bashrc
	(echo; echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"') >> /home/codespace/.zshrc

	echo "Running a Comtrya apply for codespaces ..."
	${HOME}/.cargo/bin/comtrya apply -l codespaces
	exit 0
fi

echo "Running a full Comtrya apply ..."
comtrya apply
