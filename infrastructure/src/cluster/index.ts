import * as kubernetes from "@pulumi/kubernetes";

export interface ClusterProvider {
  (args: ClusterArgs): kubernetes.Provider;
}

export interface ClusterArgs {
  name: string;
}

export interface NodePool {
  instanceType: string;
  numberOfNodes: number;
}
