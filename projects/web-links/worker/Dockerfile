FROM rust:1.62.0

RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash -

RUN curl -sS https://dl.yarnpkg.com/debian/pubkey.gpg | apt-key add -
RUN echo "deb https://dl.yarnpkg.com/debian/ stable main" | tee /etc/apt/sources.list.d/yarn.list

RUN DEBIAN_FRONTEND=noninteractive apt update && apt install --yes nodejs yarn

RUN cargo install worker-build
