import * as k8s from "@pulumi/kubernetes";
import { Controller as DnsController } from "../dns/controller";

export interface Args {
  name: string;
  dnsController: DnsController;
  nodePools: NodePool[];
}

export interface NodePool {
  instanceType: string;
  numberOfNodes: number;
}

export interface Cluster {
  provider: k8s.Provider;
}
