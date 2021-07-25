#!/usr/bin/sh
METAL_AUTH_TOKEN=$(jq -r ".metalAuthToken" /tmp/customdata.json)
METAL_PROJECT_ID=$(jq -r ".metalProjectId" /tmp/customdata.json)

cat <<EOF | kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f -
apiVersion: v1
kind: Secret
metadata:
  name: metal-cloud-config
  namespace: kube-system
stringData:
  cloud-sa.json: |
    {
    "apiKey": "${METAL_AUTH_TOKEN}",
    "projectID": "${METAL_PROJECT_ID}"
    }
EOF

kubectl --kubeconfig=/etc/kubernetes/admin.conf apply \
  -f https://github.com/equinix/cloud-provider-equinix-metal/releases/download/v3.2.1/deployment.yaml
