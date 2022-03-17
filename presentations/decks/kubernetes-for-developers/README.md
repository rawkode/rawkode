---
title: Kubernetes for Developers
theme: black
highlightTheme: shades-of-purple
---

You're in the right room if you're looking for

# Kubernetes for Developer

---

## What are we going to talk about?

---

## whoami

- Staff Developer Advocate @Pulumi
- CNCF Ambassador
- Host Kubernetes Office Hours
- Host #Klustered at https://rawkode.live
- Actor Model with Rust, Pony, Elixir, and Go

---

## What is Kubernetes?

Kubernetes (casually k8s) is an open-source container orchestrator, written in Go, designed to make it easy to deploy, manage, and scale applications.

It's safe to say that Kubernetes is now the de-facto API for deploying containerized workloads, everywhere.

And it's getting there for VMs and WASM too!

----

## Why Kubernetes?

### FREE STUFF

- API
- Supervisor
- Scaling
- Scheduling
- Logging

----

### More Importantly

- Service Discovery
- Endpoint Discovery
- Load Balancing

---

## But what is Kubernetes REALLY?

----

Kubernetes is a distributed system for running distributed systems

----

- Control Plane
  - API Server
  - Controller Manager
  - Scheduler

----

- Worker Nodes
  - Kubelet

----

Developers describe their desired state in YAML (others supported)

----

The Kubernetes API is actually a CRUD interface to a database

----

```shell
kubectl apply -f manifest.yaml
```

----

```sql
INSERT INTO pods (name, namespace, image)
VALUES ('nginx', 'default', 'nginx');
```

----

```shell
kubectl get
```

----

```sql
SELECT name, namespace, image
FROM pods
WHERE name = 'nginx'
```

----

This CRUD interface is provided by the API Server

----

Controllers (CDC/watchers) are responsible for reacting to these events

*We'll come back to this

---

### Primitives

----

#### Pods

One or more containers

----

#### Deployments

One or more pods

----

#### Services

Load balancing and service discovery for running workloads

----

#### ConfigMaps

Key value pairs that can be file system projections or environment variables

**12 factor manifesto**


---

### Pods

This is the smallest / atomic unit of work in Kubernetes

----

```yaml [1|7|8-9|10-11|6|4-5|2-3|0]
# pod.yaml
apiVersion: v1
kind: Pod
metadata:
  name: myapp
spec:
  containers:
    - name: nginx
      image: nginx
      ports:
        - containerPort: 80
```

----

# Never Deploy Pods


> Demo

Note:

- kubectl apply
- kubectl get pods
- kubectl get pods -owide
- kubectl describe
- kubectl logs
- kubectl port-forward
- kubectl edit
- kubectl delete


---

### Deployments

This is the standard unit of work in Kubernetes

----

Remember this?

```yaml
spec:
  containers:
    - name: nginx
      image: nginx
      ports:
        - containerPort: 80
```

----

```yaml [14-19|5|6|7,10|1-4|7-9|10-13|7-13]
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx
spec:
  replicas: 1
  selector:
    matchLabels:
      app: nginx
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
        - name: nginx
          image: nginx
          ports:
            - containerPort: 80

```

----

Let's take a look

> Demo

Note:

- kubectl apply
- kubectl get deployments
- kubectl get pods
- kubectl edit # replicas, strategy
- kubectl scale deployment replicas=
- kubectl autoscale deployment min/max
- kubectl delete

---

### Other Units of Work

- DaemonSets
- StatefulSets
- CronJobs / Jobs

---

### Services

Services, through convention, define how workloads communicate in Kubernetes

----

```yaml
apiVersion: v1
kind: Service
metadata:
  name: nginx
spec:
  selector:
    app: nginx
  ports:
    - port: 80
```

---

### ConfigMaps

----

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx
data:
  organization: rawkode-academy
  virtual_host: |
    This
    Could
    Be
    A
    Full
    File
```

---

### Altogether Now

> Demo
