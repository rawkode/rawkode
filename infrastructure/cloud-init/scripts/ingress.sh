#!/usr/bin/env bash
INGRESS_IP=$(jq -r ".ingressIp" /tmp/customdata.json)

export KUBECONFIG=/etc/kubernetes/admin.conf

kubectl --namespace=kube-system apply -f https://www.getambassador.io/yaml/ambassador/ambassador-crds.yaml
kubectl --namespace=kube-system apply -f https://www.getambassador.io/yaml/ambassador/ambassador-rbac.yaml

cat << EOF | kubectl apply -f -
---
apiVersion: v1
kind: Service
metadata:
  name: ambassador
  namespace: kube-system
spec:
  type: LoadBalancer
  externalTrafficPolicy: Local
  loadBalancerIP: ${INGRESS_IP}
  ports:
   - port: 80
     targetPort: 8080
  selector:
    service: ambassador
EOF
