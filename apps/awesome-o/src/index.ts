import * as pulumi from "@pulumi/pulumi";
import * as metal from "@pulumi/equinix-metal";

const config = new pulumi.Config();
const projectId = config.require("projectID");
const metro = config.require("metro");

const elasticIp = new metal.ReservedIpBlock("awesome-o", {
	projectId,
	metro,
	quantity: 1,
	type: metal.IpBlockType.PublicIPv4,
	description: "Awesome-O Public IPv4",
});

const userData = pulumi.interpolate`#!/usr/bin/env sh
# Bind K3s to our EIP & Install
export INSTALL_K3S_EXEC="--bind-address ${elasticIp.address} --advertise-address ${elasticIp.address} --node-ip ${elasticIp.address} --tls-san ${elasticIp.address} --no-deploy servicelb --disable-cloud-controller"
curl -sfL https://get.k3s.io | sh -

# kube-vip
curl https://metadata.platformequinix.com/metadata > /tmp/metadata

kubectl label node $(kubectl get nodes -o json | jq ".items[0].metadata.name") "metal.equinix.com/node-asn=$(jq ".bgp_neighbors[0].customer_as" /tmp/metadata)"
kubectl label node $(kubectl get nodes -o json | jq ".items[0].metadata.name") "metal.equinix.com/peer-asn=$(jq ".bgp_neighbors[0].peer_as" /tmp/metadata)"
kubectl label node $(kubectl get nodes -o json | jq ".items[0].metadata.name") "metal.equinix.com/peer-ip=$(jq -r ".bgp_neighbors[0].peer_ips[0]" /tmp/metadata)"
kubectl label node $(kubectl get nodes -o json | jq ".items[0].metadata.name") "metal.equinix.com/src-ip=$(jq -r ".bgp_neighbors[0].customer_ip" /tmp/metadata)"

GATEWAY_IP=$(jq -r ".network.addresses[] | select(.public == false) | .gateway" /tmp/metadata)
ip route add 169.254.255.1 via $GATEWAY_IP
ip route add 169.254.255.2 via $GATEWAY_IP

curl -o /var/lib/rancher/k3s/server/manifests/rbac.yaml -fsSL https://raw.githubusercontent.com/kube-vip/kube-vip/main/docs/manifests/rbac.yaml

crictl pull ghcr.io/kube-vip/kube-vip:v0.3.5
ctr run --rm --net-host ghcr.io/kube-vip/kube-vip:v0.3.5 kube-vip /kube-vip manifest daemonset \
  --interface lo \
  --vip ${elasticIp.address} \
  --services \
  --inCluster \
  --taint \
  --bgp \
  --metal | tee /var/lib/rancher/k3s/server/manifests/kube-vip.yaml

# GitOps all the rest
kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml apply -f https://github.com/fluxcd/flux2/releases/latest/download/install.yaml
kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml apply -f https://raw.githubusercontent.com/rawkode/rawkode/main/apps/awesome-o/opt/flux/setup.yaml
`;

const device = new metal.Device("awesome-o", {
	hostname: "awesome-o",
	billingCycle: metal.BillingCycle.Hourly,
	operatingSystem: metal.OperatingSystem.Ubuntu2004,
	plan: metal.Plan.C3SmallX86,
	metro,
	projectId,
	userData,
});

const bgp = new metal.BgpSession("awesome-o", {
	deviceId: device.id,
	addressFamily: "ipv4",
});
