#!/usr/bin/env bash
set -e
INGRESS_IP=$(jq -r ".ingressIp" /tmp/customdata.json)

cat <<EOF | kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f -
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kube-vip
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  annotations:
    rbac.authorization.kubernetes.io/autoupdate: "true"
  name: kube-vip
rules:
  - apiGroups: [""]
    resources: ["services", "services/status", "nodes"]
    verbs: ["list","get","watch", "update"]
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    verbs: ["list", "get", "watch", "update", "create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kube-vip
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: kube-vip
subjects:
- kind: ServiceAccount
  name: kube-vip
  namespace: kube-system
EOF

ctr image pull ghcr.io/kube-vip/kube-vip:latest
ctr run \
    --rm \
    --net-host \
    ghcr.io/kube-vip/kube-vip:latest \
    vip /kube-vip manifest daemonset \
      --interface lo\
      --inCluster \
      --services \
      --annotations metal.equinix.com \
      --bgp | kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f -
