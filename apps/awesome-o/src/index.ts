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

export const ingressIpAddress = elasticIp.address;

const userData = pulumi.interpolate`#!/usr/bin/env sh
# Add our EIP
cat >> /etc/network/interfaces <<EOF
auto lo:0
iface lo:0 inet static
    address ${elasticIp.address}
    netmask 255.255.255.255
EOF
ifup lo0

# Bind K3s to our EIP & Install
export INSTALL_K3S_EXEC="--bind-address ${elasticIp.address} --advertise-address ${elasticIp.address} --node-ip ${elasticIp.address} --tls-san ${elasticIp.address} --no-deploy servicelb --disable-cloud-controller"
curl -sfL https://get.k3s.io | sh -

# kube-vip
# Give BGP a minute to be enabled and update the metadata
sleep 60
curl https://metadata.platformequinix.com/metadata > /tmp/metadata

GATEWAY_IP=$(jq -r ".network.addresses[] | select(.public == false) | .gateway" /tmp/metadata)
ip route add 169.254.255.1 via $GATEWAY_IP
ip route add 169.254.255.2 via $GATEWAY_IP

curl -o /var/lib/rancher/k3s/server/manifests/rbac.yaml -fsSL https://raw.githubusercontent.com/kube-vip/kube-vip/main/docs/manifests/rbac.yaml

crictl pull ghcr.io/kube-vip/kube-vip:v0.3.5
ctr run --rm --net-host ghcr.io/kube-vip/kube-vip:v0.3.5 kube-vip /kube-vip manifest daemonset \
  --interface lo \
  --vip ${elasticIp.address} \
	--localAS $(jq ".bgp_neighbors[0].customer_as" /tmp/metadata) \
	--peerAS $(jq ".bgp_neighbors[0].peer_as" /tmp/metadata) \
	--peerAddress $(jq -r '.bgp_neighbors[0].peer_ips | join(",")' /tmp/metadata) \
	--bgpRouterID $(jq -r '.bgp_neighbors[0].customer_ip' /tmp/metadata) \
  --services \
  --inCluster \
  --taint \
  --bgp \
   | tee /var/lib/rancher/k3s/server/manifests/kube-vip.yaml

# Add our EIP  to the Traefik service, as we've no CCM
kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml patch svc traefik -n kube-system -p '{"spec": {"type": "LoadBalancer", "loadBalancerIP":"${elasticIp.address}"}}'

# GitOps all the rest
kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml apply -f https://github.com/fluxcd/flux2/releases/latest/download/install.yaml
kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml apply -f https://raw.githubusercontent.com/rawkode/rawkode/main/apps/awesome-o/opt/flux/setup.yaml
`;

const device = new metal.Device("awesome-o", {
	hostname: "awesome-o",
	billingCycle: metal.BillingCycle.Hourly,
	operatingSystem: metal.OperatingSystem.Ubuntu2004,
	plan: metal.Plan.C2MediumX86,
	metro,
	projectId,
	userData,
});

const bgp = new metal.BgpSession("awesome-o", {
	deviceId: device.id,
	addressFamily: "ipv4",
});
