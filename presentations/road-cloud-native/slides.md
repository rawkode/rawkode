---
theme: seriph
colorSchema: 'dark'
aspectRatio: '16/9'
background: cover.jpeg
fonts:
  sans: 'Avenir Next'
  serif: 'Montserrat'
  mono: 'Martian Mono'
class: 'text-center'
highlighter: shiki
lineNumbers: true
info: |
  ## The Road to Cloud Native
  by David Flanagan / @rawkode
drawings:
  persist: false
css: unocss
---

# The Road to Cloud Native

## David Flanagan

### <carbon-logo-twitter /> rawkode

---
src: vanity.md
---

---

# Let's Set The Scene

Why do we even need to discuss Cloud Native?

1. Monolith
2. SoA
3. Monolith
4. Containers
5. Microservices
6. Kubernetes
7. This is still hard

<hr style="margin: 2em;"/>

This is the order which most organisations **should** go

---

# Unfortunately ...

1. Monolith
2. Kubernetes
3. Containers
4. Microservices
5. Pain

---
layout: cover
background: https://media.tenor.com/Dm9cB77_WDcAAAAC/stargate-sg1.gif
---

# Some People Even Skip The Monolith!

---

# Skipping The Monolith Can Be Ok

## Challenges

1. Design is hard
2. Domain's aren't well understood in green field projects
3. Event driven system knowledge isn't within every organization
4. Decision fatigue

---

# Why Is This Hard?

Fallacies of Distributed Computing

- The network is reliable
- Latency is zero
- Bandwidth is infinite
- The network is secure
- Topology doesn't change
- There is one administrator
- Transport cost is zero
- The network is homogeneous

---

# Naive Implementations

- When was the last time your application had network error handling or retry logic?
  - Do you have multi-service transactions?
    - Europe infrastructure can be solid, what about the rest of the world?
- All users are in Europe, because we are
  - Do you monitor your applications / API latency from Australia?
- All users have fast internet
  - Do you compress or use binary format messaging, or JSON?
- Private networks are secure
  - Do your internal services run over TLS?
- Like networks, services aren't homogenous
  - Identify invariants, accommodate variants

---

# Micro-Services Give Us That For "Free"

"Free as in beer", hangover guaranteed

As we've adopted containers and removed the need for VMs, providing a lighter weight alternative that can be spun up sub-second; we've opened the door to them being used by default and at scale.

One of the promises of micro-services is that they allow us to write very small, trivial, applications.

"Just write a function" or "two pizza team" are common phrases used to describe the size of a micro-service.

Sadly, the devil lies in the details.

---

# Should This Be A Service?

🤷🏻‍♀️ All Services Should Be Functions, Not All Functions Should Be Services

```js
// npm: is-even:1.0.0
if (i % 2 == 0) {
   return true;
}
return false;
```

---
layout: cover
background: https://media.tenor.com/MG5did8UBG4AAAAC/jack-o-neill-richard-dean-anderson.gif
---

# Maybe Not Ideal

---

# But, In-Case You Were Wondering ...

😊

`is-odd` doesn't depend on `is-even`, but it does depend on `is-number`

```js

// is-odd:2.0.0
var isNumber = require('is-number');

module.exports = function isOdd(i) {
   if (!isNumber(i)) {
       throw new TypeError('is-odd expects a number.');
   }
   if (Number(i) !== Math.floor(i)) {
       throw new RangeError('is-odd expects an integer.');
   }
   return !!(~~i & 1);
};
```

---

# Where's the Complexity?

Infrastructure

As we spin up more micro-services, functions (potentially), we rely on a lot of infrastructure and convention to support them and make them feasible.

- Configuration
- Service discovery
- Secrets management
- Network fragility
- Logging
- Authentication
- Authorization

---
layout: section
---

# Pushed to Infrastructure Layer

---
layout: section
---

# Kubernetes is the glue

---

# FREE STUFF

- Configuration
- Secrets management
- Service discovery

## Kinda

- Logging

## Maybe

- Authentication
- Authorization
- Network fragility

---
layout: cover
background: https://media.tenor.com/H2cvoFzaq1oAAAAC/sg1-tealc.gif
---

# So what do we need to do?

---
layout: section
---

# Pick Your Stack?

---

<iframe style="width: 100%; height: 100%; border: none; margin: 4px;" src="https://landscape.cncf.io/" />

---

# Requirements

1. 12 Factor
2. Automation
3. Provide the Plumbing / Tooling
4. Profit 💰

---
layout: section
---

# 12 Factor

---
layout: section
---

# Rule 3

Store config in the environment

---
layout: section
---

# Rule 4

Treat backing services as attached resources

---
layout: section
---

# Rule 5

Strictly separate ~~~build~~~ CI and ~~~run~~~ CD stages

---
layout: section
---

# Rule 10

Keep development, staging, and production as similar as possible

---
layout: section
---

# Automation

---
layout: header-two-cols
---

# Automation Is Mandatory

::left::

- Environment Parity
- Continuous Integration
- Automated Tests
- Continuous Deployment

::right::

- Automation gives us **TRUST**
- Automation is the **FOUNDATION** on which we built

---
layout: section
---

# So ... What Do We Automate?

---
layout: cover
background: https://media.tenor.com/B6jmeB3qy4UAAAAC/daniel-jackson-stargate.gif
---

# All The Things!

---

# Table Stakes

Goal: **TRUST**

There should be no manual steps after a commit hits your `main` branch for it to get to production<sup>1</sup>.

This should happen many times a day.

Machines don't make mistakes<sup>1</sup>, people do.

<sub>1. Except "Those" Circumstances</sub>

---

# Continuous Deployment

Please Don't

We see this everywhere, from Kustomize, to Helm, to Terraform, and to every other deployment tool.

```shell

├── base
│  └── kubernetes-for-developers
├── environments
   ├── production
   ├── development
   ├── staging
   ├── preprod
   └── qa
```

**See 12-Factor rules** 3 and 10
- 03: Store config in the environment
- 10: Keep development, staging, and production as similar as possible

---

# GitOps

Well, Kinda.

GitOps is a way of managing your infrastructure and applications by using Git as a single source of truth. GitOps runs an operator in your cluster that watches a Git repository for changes to the desired state of your cluster. When a change is detected, the operator will make the necessary changes to your cluster to ensure that the actual state matches the desired state.

<hr class="m-8" />

## My Advice

Use Pulumi and Flux together. This also supports the mono-repo pattern.

---
layout: cover
background: https://media.tenor.com/2HAPiHzEwxgAAAAC/stargate-sg1.gif
---

# Plumbing & Tooling

---

# Plumbing & Tooling

There's a whole lot to do

## Distributed Systems Are Hard

As we remove the complexity from the application teams, it doesn't' disappear. It gets pushed down to the infrastructure.

---

# Observability

Pop Quiz

## How Do We Know If This Application Is Healthy?

<div class="m-12"></div>

```mermaid
flowchart LR
    Customer --> Frontend --> Backend --> Database
```

---
layout: cover
background: https://i.ytimg.com/vi/CZ3wIuvmHeM/maxresdefault.jpg
---

# How About This One?

---

# What Do We Do?

Understand

- OpenTelemetry
  - Metrics
    - Exemplars
  - Logs
  - Tracing
  - zpages

- What's Important?
  - Four Golden Signals
  - USE
  - RED

---

# What Do We Do?

Agree

- SRE
  - SLI
  - SLO
  - SLA
  - Error Budgets

---

# What Do We Do?

React

- Alerting
- Automated Remediation
- Runbooks

---
layout: cover
background: https://media.tenor.com/d1NuWXcEAa8AAAAC/calm-up-stargate.gif
---

# Services will go down

---
layout: section
---

# Service Mesh

---

# Service Mesh

Just use Linkerd 😊

Kubernetes services do provide:

- Name based discovery
- Simple load balancing

But a service mesh enriches:

- Automatic Timeouts & Retries
- mTLS
- Traffic Shaping / Advanced load balancing
- Canaries
- Circuit Breaking
- Fault Injection

---
layout: section
---

# Contracts & Shared Dependencies


---

# Adopt a MonoRepo

Strange thing to be opininated on?

## 🤷🏻

- Most distributed systems aren't homogeneous
- Protobufs are a good contract layer, even without gRPC
- Why package and version everything? It's **hard**.

## There's a reason Google, Facebook, Amazon, Twitter, etc do this.

---
layout: cover
background: https://media.tenor.com/LH3FguCZ3IsAAAAC/jack-o-neill.gif
---

# There's A Catch

---
layout: cover
background: https://media.tenor.com/HVaCs-XW31QAAAAC/sam-carter-hard.gif
---

# Your Build Tooling Isn't Good Enough

---

# Special MonoRepo Build Tooling

- Bazel (Google)
- Buck (Facebook)
- Nebula (Netflix)
- Pants (Twitter)
- Please (ThoughtMachine)

More of these show up every other month

---
layout: section
---

# Dagger Demo

## Build Piplelines as Code

---

# Let's Talk About Your APIs

Is OpenAPI Good Enough?

Now We Can Share Code/Components/Contracts, is OpenAPI our best option?

1. gRPC
2. GraphQL

---
layout: section
---

# Which?

---

# CQRS

Command Query Responsibility Separation

- gRPC is perfect for Commands (It's kinda in the name)
- GraphQL is perfect for Queries

<hr class="m-8" />

## This works because it aligns well with the domains

<div class="mt-8" />

- Commands have their logic in the Command service
- Queries have their logic in the consuming service

---
layout: cover
background: https://media.tenor.com/u-gSi_eHCN4AAAAC/travolta-stargate.gif
---

---
layout: section
---

# How Do I Run Everything Locally?

---
layout: cover
background: https://media.tenor.com/be1Z5A45z_AAAAAC/stargate-tealc.gif
---

# Close That Door

---
layout: section
---

# Develop Services In Isolation

---

# Develop Services In Isolation

1. Each service has it's own database
2. Each service has unit / integration tests
   1. Integration being:
      1. I conform
      2. Events-In-Events-Out

---
layout: cover
background: https://media.tenor.com/Iw7fMAUXYO8AAAAC/sg1-stargate.gif
---

# But I Wanna!

---

# Telepresence

Telepresence is a tool that allows you to run a service locally and connect it to a remote Kubernetes cluster.

## It's Different

It turns a file system problem into a networking problem, and that is actually solvable.

- `telepresence connect` makes Kubernetes services available locally
- `telepresence intercept service-name` makes cluster traffic hit your machine

---
layout: cover
background: https://media.tenor.com/S9Y6qvqFkssAAAAC/daniel-jackson-stargate.gif
---

---

# Recap

- Being cloud native is hard
- Be prepared to put in the foundations
  - Automation
  - Platforming
  - Observability
- Set expectations
- Adopt tools that solve problems
- Never stop experimenting

---
layout: cover
background: https://media.tenor.com/JslY-_0jW3oAAAAC/tealc-water-gun.gif
---

# Thank You / Have Fun

Any Questions?

<!--


TODO:
- gROPC and GraphQL. Use protocols that expect change
- CQRS
- API Gateways
- Async/Sync
- Demo
  - Dagger
  - Telepresence

 -->
