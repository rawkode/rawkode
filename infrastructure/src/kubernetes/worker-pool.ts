import { all, ComponentResource } from "@pulumi/pulumi";
import * as cloudinit from "@pulumi/cloudinit";
import * as metal from "@pulumi/equinix-metal";
import * as fs from "fs";

import { Cluster } from "./cluster";
import { PREFIX } from "./meta";

interface WorkerNode {
  device: metal.Device;
  bgpSession: metal.BgpSession;
}

export interface Config {
  plan: metal.Plan;
  replicas: number;
  kubernetesVersion: string;
}

export class WorkerPool extends ComponentResource {
  readonly cluster: Cluster;

  constructor(cluster: Cluster, name: string, config: Config) {
    super(
      `${PREFIX}:kubernetes:WorkerPool`,
      `${cluster.name}-${name}`,
      config,
      { parent: cluster }
    );

    this.cluster = cluster;

    for (let i = 1; i <= config.replicas; i++) {
      this.createWorkerPoolNode(name, cluster, config, i);
    }
  }

  createWorkerPoolNode(
    name: string,
    cluster: Cluster,
    config: Config,
    num: number
  ): WorkerNode {
    const device = new metal.Device(
      `${cluster.name}-${name}-${num}`,
      {
        hostname: `${cluster.name}-${name}-${num}`,
        metro: cluster.config.metro,
        billingCycle: metal.BillingCycle.Hourly,
        plan: config.plan,
        operatingSystem: metal.OperatingSystem.Ubuntu2004,
        projectId: cluster.config.projectId,
        customData: all([
          cluster.joinToken(),
          cluster.controlPlaneIp,
          cluster.ingressIp,
        ]).apply(([joinToken, controlPlaneIp, ingressIp]) =>
          JSON.stringify({
            kubernetesVersion: config.kubernetesVersion,
            joinToken,
            controlPlaneIp,
            ingressIp,
          })
        ),
        userData: cloudConfig.then((c) => c.rendered),
      },
      {
        parent: this,
        dependsOn: cluster.controlPlane
          ? cluster.controlPlane.controlPlaneDevices.map((cp) => cp.device)
          : [],
      }
    );

    const bgpSession = new metal.BgpSession(
      `${cluster.name}-${name}-${num}`,
      {
        deviceId: device.id,
        addressFamily: "ipv4",
      },
      {
        parent: this,
        dependsOn: [device],
      }
    );

    return { device, bgpSession };
  }
}

const cloudConfig = cloudinit.getConfig({
  gzip: false,
  base64Encode: false,
  parts: [
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
        "../cloud-init/scripts/kubernetes-kubeadm-worker-join.sh",
        "utf8"
      ),
    },
    {
      contentType: "text/x-shellscript",
      content: fs.readFileSync(
        "../cloud-init/scripts/net-deny-metadata.sh",
        "utf8"
      ),
    },
  ],
});
