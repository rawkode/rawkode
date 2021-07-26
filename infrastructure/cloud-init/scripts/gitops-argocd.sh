#!/usr/bin/env bash
DNS_NAME=$(jq -r ".dnsName" /tmp/customdata.json)

cat <<EOF | kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f -
apiVersion: v1
kind: Namespace
metadata:
  name: management
EOF

cat <<EOF | kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: environment-details
  namespace: management
data:
  rootDomain: ${DNS_NAME}
EOF

curl -fsSL https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml \
  | sed -E "s/namespace: argocd/namespace: management/g" \
  | kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -n management -f -

cat <<EOF | kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f -
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: management
  namespace: management
spec:
  clusterResourceWhitelist:
  - group: '*'
    kind: '*'
  destinations:
  - namespace: '*'
    server: '*'
  sourceRepos:
  - '*'
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: management
  namespace: management
spec:
  project: management
  destination:
    server: https://kubernetes.default.svc
    namespace: management
  source:
    repoURL: https://github.com/rawkode/rawkode
    path: ./infrastructure/gitops
    targetRevision: main
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
      allowEmpty: true
EOF
