#!/usr/bin/env bash
DNS_NAME=$(jq -r ".dnsName" /tmp/customdata.json)

cat <<EOF | kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f -
apiVersion: v1
kind: Namespace
metadata:
  name: argocd
EOF

cat <<EOF | kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: environment-details
  namespace: argocd
data:
  rootDomain: ${DNS_NAME}
EOF

kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

cat <<EOF | kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f -
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: teleport
  namespace: argocd
spec:
  project: default
  destination:
    server: https://kubernetes.default.svc
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
