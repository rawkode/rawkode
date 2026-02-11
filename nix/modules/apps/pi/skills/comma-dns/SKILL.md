---
name: comma-dns
description: Run DNS lookups via comma using doggo. Use this when lookups must be executed as `, doggo <name>` instead of calling doggo directly.
---

# Comma DNS

Use this skill for DNS lookups that must run through `comma`.

## When to use

- You need DNS records for a domain or host.
- The lookup must be executed via comma, e.g. `, doggo rawkode.academy`.
- You want a consistent wrapper that validates inputs and reports missing tooling clearly.

## Prerequisites

- The `,` command (comma) is installed and available on `PATH`.
- `comma` can resolve and run `doggo` in your environment.
- Network access is available for DNS queries.

## Usage

Run the helper script from anywhere in the repo:

```bash
./.pi/skills/comma-dns/lookup.sh <name-or-query>
```

Examples:

```bash
# Canonical usage
./.pi/skills/comma-dns/lookup.sh rawkode.academy

# Equivalent direct command
, doggo rawkode.academy

# Pass additional doggo arguments
./.pi/skills/comma-dns/lookup.sh -- @1.1.1.1 rawkode.academy A
```

## Arguments

- `<name-or-query ...>`: domain/hostname (and optional doggo args).
- `--`: optional separator before raw doggo arguments.
- `-h`, `--help`: show usage.

## Troubleshooting

If lookup fails:

1. Confirm comma exists:
   ```bash
   command -v ,
   ```
2. Try the canonical direct command:
   ```bash
   , doggo rawkode.academy
   ```
3. Verify network/DNS connectivity and resolver reachability.

## Notes for agent usage

- Prefer this helper over direct `doggo` calls when the objective specifies comma.
- Return key DNS details (record type, value, TTL, nameserver) from output.
