#!/usr/bin/env sh
set -eox pipefail

# Do we have Homebrew?
if [ ! command -v comtrya >/dev/null 2>&1 ]
then
	echo "Installing Homebrew ..."
	curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | sh
fi

# Do we have Comtrya?
if [ ! command -v comtrya >/dev/null 2>&1 ]
then
	echo "Installing Comtrya ..."
	curl -fsSL https://get.comtrya.dev | sh
fi

# Check if we're in a GitHub Codespaces environment
if [ ! -z "${CODESPACES}" ]
then
	sudo apt update && apt install build-essential gcc
	(echo; echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"') >> /home/codespace/.bashrc
	(echo; echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"') >> /home/codespace/.zshrc

	echo "Running a Comtrya apply for codespaces ..."
	comtrya apply -l codespaces
	exit 0
fi

echo "Running a full Comtrya apply ..."
comtrya apply
