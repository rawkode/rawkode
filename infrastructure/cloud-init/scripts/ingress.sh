#!/usr/bin/env bash
INGRESS_IP=$(jq -r ".ingressIp" /tmp/customdata.json)

kubectl --kubeconfig /etc/kubernetes/admin.conf apply -f https://www.getambassador.io/yaml/aes-crds.yaml
kubectl --kubeconfig /etc/kubernetes/admin.conf wait --for condition=established --timeout=90s crd -lproduct=aes
curl -fsSL https://www.getambassador.io/yaml/aes.yaml \
  | sed -E "s/namespace: ambassador/namespace: kube-system/g" \
  | kubectl --kubeconfig /etc/kubernetes/admin.conf apply -f -
kubectl --kubeconfig /etc/kubernetes/admin.conf -n kube-system patch svc ambassador -p "{\"spec\": {\"type\": \"LoadBalancer\", \"externalTrafficPolicy\": \"Local\", \"loadBalancerIP\": \"${INGRESS_IP}\"}}"

