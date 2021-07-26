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

curl -fsSL https://github.com/equinix/cloud-provider-equinix-metal/releases/download/v3.1.0/deployment.yaml \
  | sed -E 's/v3.1.0/7e3189de8abd08dcae35cf052b45326c29f79b7b/g' \
  | kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f -
