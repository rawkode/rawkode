---
theme: seriph
title: "Kubernetes Highlights"
mdc: true
transition: view-transition
drawings:
  persist: false
layout: cover
class: cover-center
---

<div class="grid-two items-center">
  <div>
    <div class="brand-pill">Rawkode Academy</div>
    <h1 class="mt-2 brand-gradient-text inline-block view-transition-title">Kubernetes Highlights</h1>
    <p class="text-xl opacity-80 mt-2">The best bits for newcomers</p>
    <div class="mt-6 opacity-80">
      <div><strong>David Flanagan</strong> / <strong>@rawkode.dev</strong></div>
      <div class="text-sm">//rawkode.academy</div>
    </div>
    <hr class="brand-hr mt-6" />
  </div>
  <div class="flex justify-center">
    <img src="/brand/icon-gradient.svg" alt="Rawkode Academy" class="w-52 h-52" />
  </div>
</div>

---
layout: center
class: text-left
---

<div class="grid-two items-center">
  <div>
    <div class="brand-pill">Speaker</div>
    <h1 class="mt-2 brand-gradient-text">David Flanagan</h1>
    <p class="text-xl opacity-90">Founder, Rawkode Academy</p>
    <div class="mt-4 text-lg opacity-90">
      <div><strong>@rawkode</strong></div>
      <div>rawkode.academy</div>
      <div>github.com/Rawkode</div>
    </div>
  </div>
  <div class="flex justify-center">
    <img src="/brand/icon-gradient.svg" alt="Rawkode Academy" class="w-40 h-40" />
  </div>
</div>

---
layout: center
class: text-center
---

<h1 class="brand-gradient-text text-5xl inline-block view-transition-title">What is Kubernetes?</h1>

<p class="text-2xl mt-8 opacity-90">Container Orchestration Platform</p>

<div class="mt-8 text-left max-w-2xl mx-auto">
  <div class="grid grid-cols-2 gap-6">
    <div class="p-4 rounded-lg ring-1 ring-white/15 bg-white/5">
      <div class="font-semibold text-lg">Automates</div>
      <ul class="text-sm mt-2 opacity-80 space-y-1">
        <li>Deployment</li>
        <li>Scaling</li>
        <li>Management</li>
      </ul>
    </div>
    <div class="p-4 rounded-lg ring-1 ring-white/15 bg-white/5">
      <div class="font-semibold text-lg">For</div>
      <ul class="text-sm mt-2 opacity-80 space-y-1">
        <li>Containerized applications</li>
        <li>Any infrastructure</li>
        <li>Any scale</li>
      </ul>
    </div>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">History</div>
<h2 class="mt-2 brand-gradient-text">From Google to the World</h2>

<div class="mt-8 grid grid-cols-3 gap-6">
  <div class="p-4 rounded-lg ring-1 ring-white/15 bg-white/5 text-center">
    <div class="text-3xl font-bold brand-gradient-text">2003</div>
    <div class="font-semibold mt-2">Google Borg</div>
    <p class="text-sm opacity-80 mt-1">Internal cluster management</p>
  </div>
  <div class="p-4 rounded-lg ring-1 ring-white/15 bg-white/5 text-center">
    <div class="text-3xl font-bold brand-gradient-text">2014</div>
    <div class="font-semibold mt-2">Kubernetes Born</div>
    <p class="text-sm opacity-80 mt-1">Open sourced by Google</p>
  </div>
  <div class="p-4 rounded-lg ring-1 ring-white/15 bg-white/5 text-center">
    <div class="text-3xl font-bold brand-gradient-text">2015</div>
    <div class="font-semibold mt-2">CNCF</div>
    <p class="text-sm opacity-80 mt-1">Donated to foundation</p>
  </div>
</div>

<p class="mt-8 text-center text-lg opacity-80">Today: Most popular container orchestrator, running everywhere</p>

---
layout: center
---

<div class="brand-pill">Architecture</div>
<h2 class="mt-2 mb-6 brand-gradient-text">Control Plane</h2>

<ControlPlaneDiagram />

---
layout: center
---

<div class="brand-pill">Architecture</div>
<h2 class="mt-2 mb-6 brand-gradient-text">Worker Nodes</h2>

<WorkerNodesDiagram />

---
layout: center
---

<div class="brand-pill">Architecture</div>
<h2 class="mt-2 mb-6 brand-gradient-text">Pod Scheduling Flow</h2>

<SchedulingFlowDiagram />

---
class: text-left
---

<div class="full-split">
  <div class="left-content">
    <div class="brand-pill">Core Concept</div>
    <h2 class="mt-2 brand-gradient-text">Namespaces</h2>
    <p class="text-xl opacity-80 mt-2">Virtual clusters within a cluster</p>
    <ul class="space-y-3 text-lg mt-6">
      <li v-click>Resource isolation</li>
      <li v-click>Team/project separation</li>
      <li v-click>Resource quotas per namespace</li>
      <li v-click>Default namespaces: default, kube-system</li>
    </ul>
  </div>
  <div v-click class="right-panel">

```bash
# List namespaces
kubectl get namespaces

# Create namespace
kubectl create namespace dev

# Use namespace in commands
kubectl get pods -n dev
kubectl create deployment web -n dev --image=nginx
```

  </div>
</div>

---
class: text-left
---

<div class="full-split">
  <div class="left-content">
    <div class="brand-pill">Core Concept</div>
    <h2 class="mt-2 brand-gradient-text view-transition-title">Pods</h2>
    <p class="text-xl opacity-80 mt-2">The smallest deployable unit</p>
    <ul class="space-y-3 text-lg mt-6">
      <li v-click>One or more containers</li>
      <li v-click>Shared network namespace</li>
      <li v-click>Shared storage volumes</li>
      <li v-click>Ephemeral by design</li>
    </ul>
  </div>
  <div v-click class="right-panel">

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: nginx
spec:
  containers:
  - name: nginx
    image: nginx:latest
    ports:
    - containerPort: 80
```

  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Demo</div>
<h2 class="mt-2 brand-gradient-text">Creating a Pod</h2>

<div class="mt-6 demo-block">
  <div class="demo-label">LIVE DEMO</div>

```bash
# Create a pod imperatively
kubectl run nginx --image=nginx

# Check pod status
kubectl get pods

# Get more details
kubectl describe pod nginx

# View pod logs
kubectl logs nginx

# Delete the pod
kubectl delete pod nginx
```

</div>

<p class="mt-4 text-sm opacity-70">Pods are ephemeral - they don't restart automatically!</p>

---
layout: center
class: text-left
---

<div class="full-split">
  <div class="left-content">
    <div class="brand-pill">Core Concept</div>
    <h2 class="mt-2 brand-gradient-text view-transition-title">Deployments</h2>
    <p class="text-xl opacity-80 mt-2">Declarative desired state</p>
    <ul class="space-y-3 text-lg mt-6">
      <li v-click>Manages ReplicaSets</li>
      <li v-click>Ensures desired replica count</li>
      <li v-click>Handles rolling updates</li>
      <li v-click>Supports rollbacks</li>
    </ul>
  </div>
  <div v-click class="right-panel">

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: nginx
        image: nginx:1.24
```

  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Demo</div>
<h2 class="mt-2 brand-gradient-text">Working with Deployments</h2>

<div class="mt-6 demo-block">
  <div class="demo-label">LIVE DEMO</div>

```bash
# Create a deployment
kubectl create deployment web --image=nginx --replicas=3

# Check deployment status
kubectl get deployments
kubectl get pods

# Scale up
kubectl scale deployment web --replicas=5

# Scale down
kubectl scale deployment web --replicas=2

# Delete deployment (and all its pods)
kubectl delete deployment web
```

</div>

---
class: text-left
---

<div class="full-split">
  <div class="left-content">
    <div class="brand-pill">Core Concept</div>
    <h2 class="mt-2 brand-gradient-text view-transition-title">StatefulSets</h2>
    <p class="text-xl opacity-80 mt-2">For stateful applications</p>
    <ul class="space-y-3 text-lg mt-6">
      <li v-click>Stable network identity (pod-0, pod-1)</li>
      <li v-click>Stable, persistent storage</li>
      <li v-click>Ordered deployment & scaling</li>
      <li v-click>Ordered rolling updates</li>
    </ul>
  </div>
  <div v-click class="right-panel">

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
spec:
  serviceName: postgres
  replicas: 3
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
      - name: postgres
        image: postgres:14
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 10Gi
```

  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Demo</div>
<h2 class="mt-2 brand-gradient-text">Working with StatefulSets</h2>

<div class="mt-6 demo-block">
  <div class="demo-label">LIVE DEMO</div>

```bash
# Create StatefulSet
kubectl apply -f postgres-statefulset.yaml

# Watch pods with stable names
kubectl get pods -w
# postgres-0
# postgres-1
# postgres-2

# Check persistent volume claims
kubectl get pvc
# postgres-data-postgres-0
# postgres-data-postgres-1
# postgres-data-postgres-2

# Scale up (ordered)
kubectl scale statefulset postgres --replicas=5

# Scale down (reverse order)
kubectl scale statefulset postgres --replicas=2
```

</div>

---
class: text-left
---

<div class="full-split">
  <div class="left-content">
    <div class="brand-pill">Core Concept</div>
    <h2 class="mt-2 brand-gradient-text view-transition-title">DaemonSets</h2>
    <p class="text-xl opacity-80 mt-2">One pod per node</p>
    <ul class="space-y-3 text-lg mt-6">
      <li v-click>Runs on every node (or subset)</li>
      <li v-click>Cluster-wide services</li>
      <li v-click>Logging & monitoring agents</li>
      <li v-click>Use nodeSelector for targeting</li>
    </ul>
  </div>
  <div v-click class="right-panel">

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
spec:
  selector:
    matchLabels:
      app: node-exporter
  template:
    metadata:
      labels:
        app: node-exporter
    spec:
      containers:
      - name: node-exporter
        image: prom/node-exporter
        ports:
        - containerPort: 9100
          hostPort: 9100
```

  </div>
</div>

---
layout: center
---

<div class="brand-pill">Core Concept</div>
<h2 class="mt-2 mb-6 brand-gradient-text">DaemonSet: Node Distribution</h2>

<NodeSpreadDiagram />

---
layout: center
class: text-left
---

<div class="brand-pill">Demo</div>
<h2 class="mt-2 brand-gradient-text">Exposing with Services</h2>

<div class="mt-6 demo-block">
  <div class="demo-label">LIVE DEMO</div>

```bash
# Create deployment first
kubectl create deployment web --image=nginx --replicas=3

# Expose as ClusterIP (internal)
kubectl expose deployment web --port=80

# Or expose as NodePort (external access)
kubectl expose deployment web --port=80 --type=NodePort

# Check services
kubectl get services

# Get service details
kubectl describe service web
```

</div>

---
class: text-left
---

<div class="full-split">
  <div class="left-content">
    <div class="brand-pill">Core Concept</div>
    <h2 class="mt-2 brand-gradient-text view-transition-title">Gateway API</h2>
    <p class="text-xl opacity-80 mt-2">Modern HTTP routing (replacement for Ingress)</p>
    <ul class="space-y-3 text-lg mt-6">
      <li v-click><strong>GatewayClass:</strong> Infrastructure config</li>
      <li v-click><strong>Gateway:</strong> Listeners, TLS, IPs</li>
      <li v-click><strong>HTTPRoute:</strong> Traffic routing rules</li>
      <li v-click>Role-based separation of concerns</li>
    </ul>
  </div>
  <div v-click class="right-panel">

```yaml
# Gateway (cluster ops)
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: web-gateway
spec:
  gatewayClassName: nginx
  listeners:
  - name: http
    port: 80
    protocol: HTTP
---
# HTTPRoute (devs)
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: web-route
spec:
  parentRefs:
  - name: web-gateway
  rules:
  - backendRefs:
    - name: web-service
      port: 80
```

  </div>
</div>

---
layout: center
---

<div class="brand-pill">Core Concept</div>
<h2 class="mt-2 mb-6 brand-gradient-text">Gateway API Traffic Flow</h2>

<GatewayTrafficFlow />

---
layout: center
class: text-left
---

<div class="brand-pill">Demo</div>
<h2 class="mt-2 brand-gradient-text">Setting up Gateway API</h2>

<div class="mt-6 demo-block">
  <div class="demo-label">LIVE DEMO</div>

```bash
# Install Gateway API CRDs
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.0.0/standard-install.yaml

# Install an implementation (e.g., NGINX)
kubectl apply -f https://raw.githubusercontent.com/nginxinc/kubernetes-gateway/main/config/crd/bases/gateway.nginx.org_nginxgateways.yaml

# Create a Gateway
kubectl apply -f gateway.yaml

# Create HTTPRoute
kubectl apply -f httproute.yaml

# Check status
kubectl get gateway
kubectl get httproute

# Test routing
curl http://your-gateway-ip
```

</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Comparison</div>
<h2 class="mt-2 brand-gradient-text">Ingress vs Gateway API</h2>

<div class="mt-6 grid grid-cols-2 gap-8 items-stretch">
  <div v-click class="p-4 rounded-lg ring-1 ring-orange-500/30 bg-orange-500/10">
    <div class="font-semibold text-lg text-orange-400">Ingress (Legacy)</div>
    <ul class="text-sm opacity-80 mt-2 space-y-1">
      <li>Single resource type</li>
      <li>Vendor-specific annotations</li>
      <li>Limitied to HTTP(S)</li>
      <li>No role separation</li>
      <li>Mature, widely deployed</li>
    </ul>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-green-500/30 bg-green-500/10">
    <div class="font-semibold text-lg text-green-400">Gateway API (Modern)</div>
    <ul class="text-sm opacity-80 mt-2 space-y-1">
      <li>Multiple resource types (class, gateway, route)</li>
      <li>Portable across implementations</li>
      <li>Supports TCP, UDP, TLS</li>
      <li>Role-based separation</li>
      <li>Official Kubernetes SIG</li>
    </ul>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Core Concept</div>
<h2 class="mt-2 brand-gradient-text view-transition-title">ConfigMaps & Secrets</h2>
<p class="text-xl opacity-80 mt-2">Configuration Management</p>

<div class="mt-6 grid grid-cols-2 gap-8 items-stretch">
  <div v-click class="p-4 rounded-lg ring-1 ring-blue-500/30 bg-blue-500/10">
    <div class="font-semibold text-lg">ConfigMaps</div>
    <ul class="text-sm opacity-80 mt-2 space-y-1">
      <li>Non-sensitive configuration</li>
      <li>Environment variables</li>
      <li>Config files</li>
      <li>Command-line arguments</li>
    </ul>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-orange-500/30 bg-orange-500/10">
    <div class="font-semibold text-lg">Secrets</div>
    <ul class="text-sm opacity-80 mt-2 space-y-1">
      <li>Sensitive data</li>
      <li>Passwords, tokens, keys</li>
      <li>Base64 encoded (not encrypted!)</li>
      <li>Consider external secret managers</li>
    </ul>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Demo</div>
<h2 class="mt-2 brand-gradient-text">Configuration with ConfigMaps & Secrets</h2>

<div class="mt-6 grid grid-cols-2 gap-8 items-stretch">
  <div>
    <ul class="space-y-3 text-lg">
      <li v-click>ConfigMap: non-sensitive config</li>
      <li v-click>Secret: passwords, tokens, keys</li>
      <li v-click>Consume via: env vars or volumes</li>
      <li v-click>Pod sees updated values on restart</li>
    </ul>
  </div>
  <div v-click class="demo-block">
    <div class="demo-label">LIVE DEMO</div>

```bash
# Create ConfigMap
kubectl create configmap app-config \
  --from-literal=APP_ENV=production \
  --from-literal=LOG_LEVEL=info

# Create Secret
kubectl create secret generic db-creds \
  --from-literal=username=admin \
  --from-literal=password=secret123

# View as YAML (Secrets are base64, not encrypted!)
kubectl get configmap app-config -o yaml
kubectl get secret db-creds -o yaml
```
  </div>
</div>

<div v-click class="mt-6 p-4 rounded-lg ring-1 ring-white/15 bg-white/5">
  <div class="text-sm font-mono opacity-90">
    <span class="text-blue-400"># In pod spec:</span>
    env:
      - name: APP_ENV
        valueFrom:
          configMapKeyRef:
            name: app-config
            key: APP_ENV
      - name: DB_PASS
        valueFrom:
          secretKeyRef:
            name: db-creds
            key: password
  </div>
</div>

<p class="mt-4 text-sm opacity-70">Tip: For multi-line configs, use <code>--from-file</code> or <code>--from-env-file</code></p>

---
layout: section
---

<h1 class="brand-gradient-text">Resources</h1>
<p class="text-xl opacity-80">Managing CPU, Memory & Limits</p>

---
class: text-left
---

<div class="full-split">
  <div class="left-content">
    <div class="brand-pill">Core Concept</div>
    <h2 class="mt-2 brand-gradient-text view-transition-title">Resource Requests & Limits</h2>
    <p class="text-xl opacity-80 mt-2">How Kubernetes allocates resources</p>
    <ul class="space-y-3 text-lg mt-6">
      <li v-click><strong>Requests:</strong> Guaranteed minimum</li>
      <li v-click><strong>Limits:</strong> Maximum allowed</li>
      <li v-click>Determines scheduling & QoS</li>
      <li v-click>Prevents resource starvation</li>
    </ul>
  </div>
  <div v-click class="right-panel">

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: app
spec:
  containers:
  - name: app
    image: nginx
    resources:
      requests:
        cpu: "500m"  # 0.5 cores
        memory: "512Mi"
      limits:
        cpu: "1000m" # 1 core max
        memory: "1Gi"
```

  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Core Concept</div>
<h2 class="mt-2 brand-gradient-text">Pod Quality of Service (QoS)</h2>

<div class="mt-8 grid grid-cols-3 gap-6">
  <div v-click class="p-4 rounded-lg ring-1 ring-green-500/30 bg-green-500/10">
    <div class="font-semibold text-lg text-green-400">Guaranteed</div>
    <p class="text-sm opacity-80 mt-2">requests == limits for all resources</p>
    <ul class="text-sm opacity-80 mt-2 space-y-1">
      <li>✓ Highest priority</li>
      <li>✓ Never OOMKilled</li>
      <li>✓ Fixed CPU allocation</li>
    </ul>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-yellow-500/30 bg-yellow-500/10">
    <div class="font-semibold text-lg text-yellow-400">Burstable</div>
    <p class="text-sm opacity-80 mt-2">requests set, but not equal to limits</p>
    <ul class="text-sm opacity-80 mt-2 space-y-1">
      <li>✓ Medium priority</li>
      <li>✓ Can be OOMKilled</li>
      <li>✓ Gets guaranteed CPU up to request</li>
    </ul>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-red-500/30 bg-red-500/10">
    <div class="font-semibold text-lg text-red-400">BestEffort</div>
    <p class="text-sm opacity-80 mt-2">No requests or limits specified</p>
    <ul class="text-sm opacity-80 mt-2 space-y-1">
      <li>✓ Lowest priority</li>
      <li>✓ First to be OOMKilled</li>
      <li>✓ Only gets CPU when idle</li>
    </ul>
  </div>
</div>

---
class: text-left
---

<div class="full-split">
  <div class="left-content">
    <div class="brand-pill">Core Concept</div>
    <h2 class="mt-2 brand-gradient-text">Resource Quotas</h2>
    <ul class="space-y-3 text-lg mt-6">
      <li v-click>Enforce limits per namespace</li>
      <li v-click>Prevent resource exhaustion</li>
      <li v-click>Combined with LimitRange</li>
      <li v-click>Multi-tenant cluster safety</li>
    </ul>
  </div>
  <div v-click class="right-panel">

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute-quota
  namespace: production
spec:
  hard:
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "8"
    limits.memory: 16Gi
    pods: "20"
```

  </div>
</div>

---
layout: center
---

<div class="brand-pill">Core Concept</div>
<h2 class="mt-2 mb-6 brand-gradient-text">Namespace Resource Allocation</h2>

<ResourceQuotaDiagram />

---
layout: center
class: text-left
---

<div class="brand-pill">Demo</div>
<h2 class="mt-2 brand-gradient-text">Resources in Action</h2>

<div class="mt-6 demo-block">
  <div class="demo-label">LIVE DEMO</div>

```bash
# Create pod with resources
kubectl run limited-pod --image=nginx --requests=cpu=500m,memory=256Mi --limits=cpu=1000m,memory=512Mi

# Check pod QoS class
kubectl get pod limited-pod -o jsonpath='{.status.qosClass}'

# View resource usage
kubectl top pods
kubectl top nodes

# Create pod without resources (BestEffort)
kubectl run besteffort-pod --image=nginx
kubectl get pod besteffort-pod -o jsonpath='{.status.qosClass}'

# Trigger OOMKilled (exceed limits)
kubectl run oom-pod --image=stress --limits=memory=100Mi -- stress --vm 1 --vm-bytes 200M --timeout 20s
kubectl get pod oom-pod
```

</div>

---
layout: section
---

<h1 class="brand-gradient-text">Key Highlights</h1>
<p class="text-xl opacity-80">What makes Kubernetes special</p>

---
class: text-left
---

<div class="full-split">
  <div class="left-content">
    <div class="brand-pill">Highlight #1</div>
    <h2 class="mt-2 brand-gradient-text view-transition-title">Self-Healing</h2>
    <ul class="space-y-4 text-lg mt-6">
      <li v-click><strong>Restarts</strong> failed containers</li>
      <li v-click><strong>Replaces</strong> pods on failed nodes</li>
      <li v-click><strong>Kills</strong> unresponsive pods (health checks)</li>
      <li v-click><strong>Doesn't advertise</strong> until ready</li>
    </ul>
  </div>
  <div v-click class="right-panel demo-panel">
    <div class="demo-label">LIVE DEMO</div>

```bash
# Create deployment
kubectl create deployment web \
  --image=nginx --replicas=3

# Watch pods
kubectl get pods -w

# In another terminal, delete a pod
kubectl delete pod <pod-name>

# Watch it get recreated!
```

  </div>
</div>

---
layout: center
---

<ProbeSimulator />

---
class: text-left
---

<div class="full-split">
  <div class="left-content">
    <div class="brand-pill">Highlight #2</div>
    <h2 class="mt-2 brand-gradient-text view-transition-title">Rolling Updates</h2>
    <ul class="space-y-4 text-lg mt-6">
      <li v-click>Zero-downtime deployments</li>
      <li v-click>Gradual rollout of new version</li>
      <li v-click>Automatic rollback on failure</li>
      <li v-click>Configurable update strategy</li>
    </ul>
  </div>
  <div v-click class="right-panel demo-panel">
    <div class="demo-label">LIVE DEMO</div>

```bash
# Update image version
kubectl set image deployment/web \
  nginx=nginx:1.25

# Watch the rollout
kubectl rollout status deployment/web

# View rollout history
kubectl rollout history deployment/web

# Rollback if needed
kubectl rollout undo deployment/web
```

  </div>
</div>

---
class: text-left
---

<div class="full-split">
  <div class="left-content">
    <div class="brand-pill">Highlight #3</div>
    <h2 class="mt-2 brand-gradient-text view-transition-title">Horizontal Scaling</h2>
    <ul class="space-y-4 text-lg mt-6">
      <li v-click>Manual scaling with kubectl</li>
      <li v-click>HPA - Horizontal Pod Autoscaler</li>
      <li v-click>Scale based on CPU/memory</li>
      <li v-click>Custom metrics support</li>
    </ul>
  </div>
  <div v-click class="right-panel demo-panel">
    <div class="demo-label">LIVE DEMO</div>

```bash
# Manual scaling
kubectl scale deployment web --replicas=10

# Watch pods scale up
kubectl get pods -w

# Scale back down
kubectl scale deployment web --replicas=2

# Or use autoscaling
kubectl autoscale deployment web \
  --min=2 --max=10 --cpu-percent=50
```

  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Highlight #4</div>
<h2 class="mt-2 brand-gradient-text view-transition-title">Declarative Configuration</h2>

<div class="mt-6">
  <p class="text-xl opacity-90 mb-6">Tell Kubernetes <em>what you want</em>, not <em>how to do it</em></p>

  <div class="grid grid-cols-2 gap-8">
    <div v-click class="p-4 rounded-lg ring-1 ring-red-500/30 bg-red-500/10">
      <div class="font-semibold">Imperative (How)</div>
      <ul class="text-sm opacity-80 mt-2 space-y-1">
        <li>Create pod A</li>
        <li>If pod A dies, create pod B</li>
        <li>Scale from 3 to 5 pods</li>
        <li>Hard to reproduce</li>
      </ul>
    </div>
    <div v-click class="p-4 rounded-lg ring-1 ring-green-500/30 bg-green-500/10">
      <div class="font-semibold">Declarative (What)</div>
      <ul class="text-sm opacity-80 mt-2 space-y-1">
        <li>"I want 5 replicas"</li>
        <li>Kubernetes figures out the rest</li>
        <li>Git-friendly (YAML files)</li>
        <li>Self-documenting infrastructure</li>
      </ul>
    </div>
  </div>
</div>

---
class: text-left
---

<div class="full-split">
  <div class="left-content">
    <div class="brand-pill">Highlight #5</div>
    <h2 class="mt-2 brand-gradient-text view-transition-title">Storage Orchestration</h2>
    <ul class="space-y-4 text-lg mt-6">
      <li v-click><strong>PersistentVolumes</strong> - cluster storage</li>
      <li v-click><strong>PersistentVolumeClaims</strong> - request storage</li>
      <li v-click><strong>StorageClasses</strong> - dynamic provisioning</li>
      <li v-click>Works with cloud providers, NFS, local, etc.</li>
    </ul>
  </div>
  <div v-click class="right-panel">

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-claim
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
```

  </div>
</div>

---
layout: section
---

<h1 class="brand-gradient-text">The Ecosystem</h1>
<p class="text-xl opacity-80">Beyond core Kubernetes</p>

---
layout: center
class: text-left
---

<div class="brand-pill">Ecosystem</div>
<h2 class="mt-2 brand-gradient-text">Tools & Extensions</h2>

<div class="mt-8 grid grid-cols-3 gap-6">
  <div v-click class="p-4 rounded-lg ring-1 ring-blue-500/30 bg-blue-500/10">
    <div class="font-semibold text-lg">Helm</div>
    <p class="text-sm opacity-80 mt-2">Package manager for Kubernetes. Charts bundle related resources.</p>
    <code class="text-xs mt-2 block opacity-60">helm install prometheus prometheus-community/prometheus</code>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-purple-500/30 bg-purple-500/10">
    <div class="font-semibold text-lg">Operators</div>
    <p class="text-sm opacity-80 mt-2">Custom controllers that encode operational knowledge.</p>
    <p class="text-xs mt-2 opacity-60">Automate Day 2 operations</p>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-green-500/30 bg-green-500/10">
    <div class="font-semibold text-lg">GitOps</div>
    <p class="text-sm opacity-80 mt-2">Git as source of truth. Flux, ArgoCD.</p>
    <p class="text-xs mt-2 opacity-60">Declarative, auditable, collaborative</p>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Getting Started</div>
<h2 class="mt-2 brand-gradient-text">Local Development Options</h2>

<div class="mt-8 grid grid-cols-3 gap-6">
  <div v-click class="p-4 rounded-lg ring-1 ring-white/15 bg-white/5">
    <div class="font-semibold text-lg">kind</div>
    <p class="text-sm opacity-80 mt-2">Kubernetes in Docker. Fast, lightweight.</p>
    <code class="text-xs mt-2 block opacity-60">kind create cluster</code>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-white/15 bg-white/5">
    <div class="font-semibold text-lg">minikube</div>
    <p class="text-sm opacity-80 mt-2">Single-node cluster. Many drivers.</p>
    <code class="text-xs mt-2 block opacity-60">minikube start</code>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-white/15 bg-white/5">
    <div class="font-semibold text-lg">Docker Desktop</div>
    <p class="text-sm opacity-80 mt-2">Built-in Kubernetes. Enable in settings.</p>
    <p class="text-xs mt-2 opacity-60">Easy for beginners</p>
  </div>
</div>

<div v-click class="mt-8 p-4 rounded-lg ring-1 ring-blue-500/30 bg-blue-500/10">
  <p class="font-semibold">Managed Kubernetes (Production)</p>
  <p class="text-sm opacity-80 mt-1">GKE (Google) | EKS (AWS) | AKS (Azure) | DigitalOcean | Linode | Civo</p>
</div>

---
layout: section
---

<h1 class="brand-gradient-text">Why Kubernetes is the Default</h1>
<p class="text-xl opacity-80">The well-trodden path in 2026</p>

---
layout: center
class: text-left
---

<div class="brand-pill">The Big Picture</div>
<h2 class="mt-2 brand-gradient-text">The Well-Trodden Path</h2>

<div class="mt-6">
  <p class="text-xl opacity-90 mb-6">In 2026, <strong>not using Kubernetes is the risk</strong></p>

  <div class="grid grid-cols-2 gap-6">
    <div v-click class="p-4 rounded-lg ring-1 ring-green-500/30 bg-green-500/10">
      <div class="font-semibold text-lg">10+ Years Battle-Tested</div>
      <p class="text-sm opacity-80 mt-2">From Google Borg to production everywhere. The patterns are proven.</p>
    </div>
    <div v-click class="p-4 rounded-lg ring-1 ring-green-500/30 bg-green-500/10">
      <div class="font-semibold text-lg">Every Vendor, Every Cloud</div>
      <p class="text-sm opacity-80 mt-2">GKE, EKS, AKS, and hundreds more. Universal support.</p>
    </div>
    <div v-click class="p-4 rounded-lg ring-1 ring-green-500/30 bg-green-500/10">
      <div class="font-semibold text-lg">Largest Ecosystem in Infrastructure</div>
      <p class="text-sm opacity-80 mt-2">CNCF landscape: 1000+ projects. Everything integrates.</p>
    </div>
    <div v-click class="p-4 rounded-lg ring-1 ring-green-500/30 bg-green-500/10">
      <div class="font-semibold text-lg">Going Custom = Reinventing Wheels</div>
      <p class="text-sm opacity-80 mt-2">Why build what already exists? Focus on your product.</p>
    </div>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Skip the Hard Work</div>
<h2 class="mt-2 brand-gradient-text">Jet-Setting with Kubernetes</h2>
<p class="text-xl opacity-80 mt-2">Let someone else do the heavy lifting</p>

<div class="mt-6 grid grid-cols-2 gap-8">
  <div>
    <ul class="space-y-4 text-lg">
      <li v-click><strong>Spectro Cloud Palette</strong> - full-stack K8s management</li>
      <li v-click>Multi-cluster, multi-cloud, edge - one platform</li>
      <li v-click>Declarative cluster profiles</li>
      <li v-click>Day 2 operations solved</li>
    </ul>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-purple-500/30 bg-purple-500/10">
    <p class="text-sm opacity-90">
      <strong>The insight:</strong> You don't have to build everything yourself. Platforms like Spectro Cloud handle the complexity.
    </p>
    <p class="text-sm opacity-90 mt-3">
      <strong>Shameless plug:</strong> Spectro Cloud and I collaborated on a Day 2 Operations course. Link at the end!
    </p>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Reality Check</div>
<h2 class="mt-2 brand-gradient-text">The Cost of DIY</h2>
<p class="text-xl opacity-80 mt-2">What you have to build yourself without Kubernetes</p>

<div class="mt-6 grid grid-cols-2 gap-6">
  <div v-click class="p-4 rounded-lg ring-1 ring-red-500/30 bg-red-500/10">
    <div class="font-semibold">Custom Deployment Pipelines</div>
    <p class="text-sm opacity-80 mt-1">Rolling updates, rollbacks, health checks... from scratch</p>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-red-500/30 bg-red-500/10">
    <div class="font-semibold">Bespoke Monitoring & Alerting</div>
    <p class="text-sm opacity-80 mt-1">No standard metrics, no ecosystem integrations</p>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-red-500/30 bg-red-500/10">
    <div class="font-semibold">Manual Certificate Management</div>
    <p class="text-sm opacity-80 mt-1">Renewing certs at 3am because you forgot</p>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-red-500/30 bg-red-500/10">
    <div class="font-semibold">Proprietary Scaling Solutions</div>
    <p class="text-sm opacity-80 mt-1">Custom autoscaling that only your team understands</p>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-red-500/30 bg-red-500/10">
    <div class="font-semibold">No Portable Skills</div>
    <p class="text-sm opacity-80 mt-1">Your team's knowledge doesn't transfer anywhere</p>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-red-500/30 bg-red-500/10">
    <div class="font-semibold">Vendor Lock-in Without Benefits</div>
    <p class="text-sm opacity-80 mt-1">Locked in, but without the ecosystem advantages</p>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Free with K8s</div>
<h2 class="mt-2 brand-gradient-text">GitOps</h2>
<p class="text-xl opacity-80 mt-2">Git as the source of truth for infrastructure</p>

<div class="mt-6 grid grid-cols-2 gap-8">
  <div>
    <ul class="space-y-4 text-lg">
      <li v-click><strong>Flux & ArgoCD</strong> - industry standards</li>
      <li v-click>Declarative, auditable, rollback-friendly</li>
      <li v-click>PR-based infrastructure changes</li>
      <li v-click>Self-healing drift detection</li>
    </ul>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-green-500/30 bg-green-500/10">
    <p class="text-sm opacity-90">
      <strong>Without K8s:</strong> Build your own sync engine, write custom reconciliation loops, implement drift detection...
    </p>
    <p class="text-sm opacity-90 mt-3">
      <strong>With K8s:</strong> <code>flux bootstrap</code> and you're done.
    </p>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Free with K8s</div>
<h2 class="mt-2 brand-gradient-text">Observability</h2>
<p class="text-xl opacity-80 mt-2">Metrics, logs, and traces that just work</p>

<div class="mt-6 grid grid-cols-2 gap-8">
  <div>
    <ul class="space-y-4 text-lg">
      <li v-click><strong>Prometheus & Grafana</strong> - the standard</li>
      <li v-click><strong>OpenTelemetry</strong> - vendor-neutral tracing</li>
      <li v-click>Every tool integrates out of the box</li>
      <li v-click>No proprietary vendor lock-in</li>
    </ul>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-green-500/30 bg-green-500/10">
    <p class="text-sm opacity-90">
      <strong>Without K8s:</strong> Integrate each service manually, build custom dashboards, hope your metrics format is compatible...
    </p>
    <p class="text-sm opacity-90 mt-3">
      <strong>With K8s:</strong> <code>helm install prometheus</code> - instant visibility.
    </p>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Free with K8s</div>
<h2 class="mt-2 brand-gradient-text">Service Mesh</h2>
<p class="text-xl opacity-80 mt-2">Zero-trust networking made easy</p>

<div class="mt-6 grid grid-cols-2 gap-8">
  <div>
    <ul class="space-y-4 text-lg">
      <li v-click><strong>Istio, Linkerd, Cilium</strong> - pick your flavor</li>
      <li v-click>mTLS everywhere (zero-trust)</li>
      <li v-click>Traffic management, retries, circuit breaking</li>
      <li v-click>Observability built into the network layer</li>
    </ul>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-green-500/30 bg-green-500/10">
    <p class="text-sm opacity-90">
      <strong>Without K8s:</strong> Implement TLS between every service, build retry logic everywhere, create custom traffic routing...
    </p>
    <p class="text-sm opacity-90 mt-3">
      <strong>With K8s:</strong> Automatic encryption, retries, and observability with zero code changes.
    </p>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Free with K8s</div>
<h2 class="mt-2 brand-gradient-text">Security Scanning & Posture</h2>
<p class="text-xl opacity-80 mt-2">Security built into the platform</p>

<div class="mt-6 grid grid-cols-2 gap-8">
  <div>
    <ul class="space-y-4 text-lg">
      <li v-click><strong>Trivy, Grype</strong> - image vulnerability scanning</li>
      <li v-click><strong>Falco</strong> - runtime threat detection</li>
      <li v-click><strong>Kubescape</strong> - compliance frameworks</li>
      <li v-click>CIS, NSA, NIST benchmarks built-in</li>
    </ul>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-green-500/30 bg-green-500/10">
    <p class="text-sm opacity-90">
      <strong>Without K8s:</strong> Build your own scanning pipeline, write custom compliance checks, implement runtime monitoring...
    </p>
    <p class="text-sm opacity-90 mt-3">
      <strong>With K8s:</strong> Industry-standard security tools that understand your infrastructure.
    </p>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Free with K8s</div>
<h2 class="mt-2 brand-gradient-text">Platform Engineering</h2>
<p class="text-xl opacity-80 mt-2">Build internal developer platforms on solid foundations</p>

<div class="mt-6 grid grid-cols-2 gap-8">
  <div>
    <ul class="space-y-4 text-lg">
      <li v-click><strong>Backstage</strong> - developer portals</li>
      <li v-click><strong>Crossplane</strong> - infrastructure as code</li>
      <li v-click><strong>Port</strong> - self-service catalogs</li>
      <li v-click>Golden paths for developers</li>
    </ul>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-green-500/30 bg-green-500/10">
    <p class="text-sm opacity-90">
      <strong>Without K8s:</strong> Build your own developer portal, create custom provisioning systems, reinvent service catalogs...
    </p>
    <p class="text-sm opacity-90 mt-3">
      <strong>With K8s:</strong> Plug into a mature ecosystem of platform tools.
    </p>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Free with K8s</div>
<h2 class="mt-2 brand-gradient-text">Certificate Management</h2>
<p class="text-xl opacity-80 mt-2">Never manually renew a certificate again</p>

<div class="mt-6 grid grid-cols-2 gap-8">
  <div>
    <ul class="space-y-4 text-lg">
      <li v-click><strong>cert-manager</strong> - the standard</li>
      <li v-click>Automatic TLS certificates</li>
      <li v-click>Let's Encrypt integration</li>
      <li v-click>Auto-renewal before expiry</li>
    </ul>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-green-500/30 bg-green-500/10">
    <p class="text-sm opacity-90">
      <strong>Without K8s:</strong> Calendar reminders, manual renewal scripts, 3am pages when certs expire...
    </p>
    <p class="text-sm opacity-90 mt-3">
      <strong>With K8s:</strong> Set it once, forget forever. Certificates just work.
    </p>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Free with K8s</div>
<h2 class="mt-2 brand-gradient-text">Cost Management / FinOps</h2>
<p class="text-xl opacity-80 mt-2">Know where every dollar goes</p>

<div class="mt-6 grid grid-cols-2 gap-8">
  <div>
    <ul class="space-y-4 text-lg">
      <li v-click><strong>Kubecost, OpenCost</strong> - cost visibility</li>
      <li v-click>Per-namespace, per-team allocation</li>
      <li v-click>Right-sizing recommendations</li>
      <li v-click>Cloud spend optimization</li>
    </ul>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-green-500/30 bg-green-500/10">
    <p class="text-sm opacity-90">
      <strong>Without K8s:</strong> Parse cloud bills manually, guess at team allocation, no optimization insights...
    </p>
    <p class="text-sm opacity-90 mt-3">
      <strong>With K8s:</strong> Real-time cost visibility per workload, per team, per namespace.
    </p>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Free with K8s</div>
<h2 class="mt-2 brand-gradient-text">Progressive Delivery</h2>
<p class="text-xl opacity-80 mt-2">Deploy with confidence</p>

<div class="mt-6 grid grid-cols-2 gap-8">
  <div>
    <ul class="space-y-4 text-lg">
      <li v-click><strong>Argo Rollouts, Flagger</strong></li>
      <li v-click>Canary deployments</li>
      <li v-click>Blue-green releases</li>
      <li v-click>Automatic rollback on failure</li>
    </ul>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-green-500/30 bg-green-500/10">
    <p class="text-sm opacity-90">
      <strong>Without K8s:</strong> Build custom traffic splitting, implement health-based promotion, write rollback automation...
    </p>
    <p class="text-sm opacity-90 mt-3">
      <strong>With K8s:</strong> Declarative canary: "promote after 5 min if error rate < 1%"
    </p>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Free with K8s</div>
<h2 class="mt-2 brand-gradient-text">Backup & Disaster Recovery</h2>
<p class="text-xl opacity-80 mt-2">Sleep well at night</p>

<div class="mt-6 grid grid-cols-2 gap-8">
  <div>
    <ul class="space-y-4 text-lg">
      <li v-click><strong>Velero</strong> - the standard for K8s backup</li>
      <li v-click>Cluster backup and restore</li>
      <li v-click>Cross-cluster migration</li>
      <li v-click>Scheduled backups with retention</li>
    </ul>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-green-500/30 bg-green-500/10">
    <p class="text-sm opacity-90">
      <strong>Without K8s:</strong> Custom backup scripts per service, manual restore procedures, hope you tested recovery...
    </p>
    <p class="text-sm opacity-90 mt-3">
      <strong>With K8s:</strong> <code>velero restore create --from-backup prod-daily</code>
    </p>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Free with K8s</div>
<h2 class="mt-2 brand-gradient-text">Autoscaling</h2>
<p class="text-xl opacity-80 mt-2">Scale to zero, scale to thousands</p>

<div class="mt-6 grid grid-cols-2 gap-8">
  <div>
    <ul class="space-y-4 text-lg">
      <li v-click><strong>HPA</strong> - built into Kubernetes</li>
      <li v-click><strong>KEDA</strong> - event-driven scaling</li>
      <li v-click><strong>Karpenter</strong> - node autoscaling</li>
      <li v-click>Scale on any metric you can measure</li>
    </ul>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-green-500/30 bg-green-500/10">
    <p class="text-sm opacity-90">
      <strong>Without K8s:</strong> Build custom scaling logic, implement queue-based scaling, manage node pools manually...
    </p>
    <p class="text-sm opacity-90 mt-3">
      <strong>With K8s:</strong> "Scale from 0 to 100 based on Kafka lag" - declarative.
    </p>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Free with K8s</div>
<h2 class="mt-2 brand-gradient-text">Policy as Code</h2>
<p class="text-xl opacity-80 mt-2">Governance guardrails that scale</p>

<div class="mt-6 grid grid-cols-2 gap-8">
  <div>
    <ul class="space-y-4 text-lg">
      <li v-click><strong>OPA/Gatekeeper, Kyverno</strong></li>
      <li v-click>Enforce standards automatically</li>
      <li v-click>Shift-left compliance</li>
      <li v-click>Audit and mutation policies</li>
    </ul>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-green-500/30 bg-green-500/10">
    <p class="text-sm opacity-90">
      <strong>Without K8s:</strong> Manual code reviews for compliance, post-deployment audits, inconsistent enforcement...
    </p>
    <p class="text-sm opacity-90 mt-3">
      <strong>With K8s:</strong> "Block deployments without resource limits" - enforced at admission.
    </p>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Free with K8s</div>
<h2 class="mt-2 brand-gradient-text">Developer Experience</h2>
<p class="text-xl opacity-80 mt-2">Fast iteration, production-like environments</p>

<div class="mt-6 grid grid-cols-2 gap-8">
  <div>
    <ul class="space-y-4 text-lg">
      <li v-click><strong>Telepresence</strong> - local dev, remote cluster</li>
      <li v-click><strong>Tilt, Skaffold</strong> - fast rebuild loops</li>
      <li v-click>Production-like environments locally</li>
      <li v-click>Hot reload into running clusters</li>
    </ul>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-green-500/30 bg-green-500/10">
    <p class="text-sm opacity-90">
      <strong>Without K8s:</strong> Docker Compose that doesn't match prod, "works on my machine" syndrome...
    </p>
    <p class="text-sm opacity-90 mt-3">
      <strong>With K8s:</strong> Develop against the real thing, catch issues before they hit staging.
    </p>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Free with K8s</div>
<h2 class="mt-2 brand-gradient-text">Database Operators</h2>
<p class="text-xl opacity-80 mt-2">Production databases without a dedicated DBA</p>

<div class="mt-6 grid grid-cols-2 gap-8">
  <div>
    <ul class="space-y-4 text-lg">
      <li v-click><strong>CloudNativePG</strong> - PostgreSQL</li>
      <li v-click><strong>Vitess</strong> - MySQL at scale</li>
      <li v-click><strong>Strimzi</strong> - Kafka</li>
      <li v-click>Automated backups, failover, scaling</li>
    </ul>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-green-500/30 bg-green-500/10">
    <p class="text-sm opacity-90">
      <strong>Without K8s:</strong> Manual database administration, custom failover scripts, hope your backups work...
    </p>
    <p class="text-sm opacity-90 mt-3">
      <strong>With K8s:</strong> Declarative databases with automatic failover and point-in-time recovery.
    </p>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Free with K8s</div>
<h2 class="mt-2 brand-gradient-text">Edge Computing</h2>
<p class="text-xl opacity-80 mt-2">Same platform, from cloud to edge</p>

<div class="mt-6 grid grid-cols-2 gap-8">
  <div>
    <ul class="space-y-4 text-lg">
      <li v-click><strong>Kairos</strong> - immutable OS for K8s at the edge</li>
      <li v-click><strong>K3s</strong> - lightweight K8s for edge</li>
      <li v-click><strong>KubeEdge</strong> - extend clusters to edge nodes</li>
      <li v-click><strong>Akri</strong> - discover leaf devices</li>
    </ul>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-green-500/30 bg-green-500/10">
    <p class="text-sm opacity-90">
      <strong>Without K8s:</strong> Different tooling for edge vs cloud, custom sync mechanisms, fragmented operations...
    </p>
    <p class="text-sm opacity-90 mt-3">
      <strong>With K8s:</strong> Deploy to retail stores, factories, or satellites with the same workflow as cloud.
    </p>
  </div>
</div>

---
layout: center
class: text-left
---

<div class="brand-pill">Free with K8s</div>
<h2 class="mt-2 brand-gradient-text">Portable Skills</h2>
<p class="text-xl opacity-80 mt-2">Your investment pays off everywhere</p>

<div class="mt-6 grid grid-cols-2 gap-8">
  <div>
    <ul class="space-y-4 text-lg">
      <li v-click><strong>GKE, EKS, AKS, on-prem</strong> - same skills</li>
      <li v-click>Millions of K8s practitioners worldwide</li>
      <li v-click>Hiring pool is massive</li>
      <li v-click>Career investment that transfers</li>
    </ul>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-green-500/30 bg-green-500/10">
    <p class="text-sm opacity-90">
      <strong>Without K8s:</strong> Proprietary knowledge that doesn't transfer. New hires start from zero.
    </p>
    <p class="text-sm opacity-90 mt-3">
      <strong>With K8s:</strong> Hire someone with K8s experience - they're productive on day one.
    </p>
  </div>
</div>

---
layout: center
class: text-center
---

<div class="brand-pill">Key Takeaways</div>
<h2 class="mt-4 brand-gradient-text text-4xl">What We Learned</h2>

<div class="mt-8 grid grid-cols-3 gap-6 text-left max-w-4xl mx-auto">
  <div v-click class="p-4 rounded-lg ring-1 ring-white/15 bg-white/5">
    <div class="font-semibold">Self-Healing</div>
    <p class="text-sm opacity-80 mt-1">Automatic restarts, rescheduling, and health checks keep apps running.</p>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-white/15 bg-white/5">
    <div class="font-semibold">Declarative</div>
    <p class="text-sm opacity-80 mt-1">Describe desired state—"I want 5 replicas"—and Kubernetes figures out how.</p>
  </div>
  <div v-click class="p-4 rounded-lg ring-1 ring-white/15 bg-white/5">
    <div class="font-semibold">Scale</div>
    <p class="text-sm opacity-80 mt-1">Horizontal Pod Autoscaler scales on CPU, memory, or custom metrics.</p>
  </div>
</div>

---
layout: center
class: text-center
---

<div class="brand-pill">Resources</div>
<h2 class="mt-4 brand-gradient-text text-4xl">Learn More</h2>

<div class="mt-8 text-left max-w-2xl mx-auto space-y-4">
  <div v-click class="p-3 rounded-lg ring-1 ring-white/15 bg-white/5">
    <strong>Official Docs:</strong> kubernetes.io/docs
  </div>
  <div v-click class="p-3 rounded-lg ring-1 ring-white/15 bg-white/5">
    <strong>Interactive Tutorial:</strong> kubernetes.io/docs/tutorials/kubernetes-basics
  </div>
  <div v-click class="p-3 rounded-lg ring-1 ring-white/15 bg-white/5">
    <strong>Rawkode Academy:</strong> rawkode.academy
  </div>
  <div v-click class="p-3 rounded-lg ring-1 ring-white/15 bg-white/5">
    <strong>CNCF Landscape:</strong> landscape.cncf.io
  </div>
</div>

---
layout: center
class: text-center
---

<div class="grid-two items-center">
  <div>
    <div class="brand-pill">Thank You!</div>
    <h1 class="mt-2 brand-gradient-text inline-block">Questions?</h1>
    <div class="mt-6 opacity-80">
      <div><strong>David Flanagan</strong></div>
      <div class="mt-2">@rawkode.dev</div>
      <div>rawkode.academy</div>
    </div>
    <hr class="brand-hr mt-6" />
  </div>
  <div class="flex justify-center">
    <img src="/brand/icon-gradient.svg" alt="Rawkode Academy" class="w-52 h-52" />
  </div>
</div>
