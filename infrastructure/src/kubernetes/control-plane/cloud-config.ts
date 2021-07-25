import * as cloudinit from "@pulumi/cloudinit";
import * as fs from "fs";

export const cloudConfig = cloudinit.getConfig({
  gzip: false,
  base64Encode: false,
  parts: [
    {
      contentType: "text/x-shellscript",
      content: fs.readFileSync(
        "../cloud-init/scripts/wait-for-bgp-enabled.sh",
        "utf8"
      ),
    },
    {
      contentType: "text/x-shellscript",
      content: fs.readFileSync(
        "../cloud-init/scripts/download-metadata.sh",
        "utf8"
      ),
    },
    {
      contentType: "text/x-shellscript",
      content: fs.readFileSync(
        "../cloud-init/scripts/add-bgp-routes.sh",
        "utf8"
      ),
    },
    {
      contentType: "text/x-shellscript",
      content: fs.readFileSync(
        "../cloud-init/scripts/base-packages.sh",
        "utf8"
      ),
    },
    {
      contentType: "text/x-shellscript",
      content: fs.readFileSync("../cloud-init/scripts/containerd.sh", "utf8"),
    },
    {
      contentType: "text/x-shellscript",
      content: fs.readFileSync(
        "../cloud-init/scripts/kubernetes-prerequisites.sh",
        "utf8"
      ),
    },
    {
      contentType: "text/x-shellscript",
      content: fs.readFileSync(
        "../cloud-init/scripts/kubernetes-packages.sh",
        "utf8"
      ),
    },
    {
      contentType: "text/x-shellscript",
      content: fs.readFileSync(
        "../cloud-init/scripts/kubernetes-kubeadm-config.sh",
        "utf8"
      ),
    },
    {
      contentType: "text/x-shellscript",
      content: fs.readFileSync(
        "../cloud-init/scripts/kubernetes-kubeadm-certs.sh",
        "utf8"
      ),
    },
    {
      contentType: "text/x-shellscript",
      content: fs.readFileSync("../cloud-init/scripts/kube-vip.sh", "utf8"),
    },
    {
      contentType: "text/x-shellscript",
      content: fs.readFileSync(
        "../cloud-init/scripts/kubernetes-kubeadm-exec.sh",
        "utf8"
      ),
    },
    {
      contentType: "text/x-shellscript",
      content: fs.readFileSync("../cloud-init/scripts/helm.sh", "utf8"),
    },
    {
      contentType: "text/x-shellscript",
      content: fs.readFileSync("../cloud-init/scripts/cni-cilium.sh", "utf8"),
    },
    {
      contentType: "text/x-shellscript",
      content: fs.readFileSync(
        "../cloud-init/scripts/equinix-metal-ccm.sh",
        "utf8"
      ),
    },
    {
      contentType: "text/x-shellscript",
      content: fs.readFileSync(
        "../cloud-init/scripts/kube-vip-daemonset.sh",
        "utf8"
      ),
    },
    {
      contentType: "text/x-shellscript",
      content: fs.readFileSync("../cloud-init/scripts/ingress.sh", "utf8"),
    },
    {
      contentType: "text/x-shellscript",
      content: fs.readFileSync(
        "../cloud-init/scripts/gitops-argocd.sh",
        "utf8"
      ),
    },
  ],
});
