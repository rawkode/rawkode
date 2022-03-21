// import * as pulumi from "@pulumi/pulumi";
// import * as k8s from "@pulumi/kubernetes";

// const knativeManifest =
//   "https://github.com/knative/operator/releases/download/knative-{VERSION}/operator.yaml";

// export const install = (version: string, provider: k8s.Provider) => {
//   provider.id.apply((id) => {
//     new k8s.yaml.ConfigFile(
//       `${id}-knative`,
//       { file: knativeManifest.replace("{VERSION}", version) },
//       { provider }
//     );

//     const knativeNamespace = new k8s.core.v1.Namespace(
//       `${id}-knative`,
//       {
//         metadata: {
//           name: "knative",
//         },
//       },
//       { provider }
//     );

//     // const knativeServing = new knative.operator.v1alpha1.KnativeServing(
//     //   "knative-serving",
//     //   {
//     //     metadata: {
//     //       name: "knative-serving",
//     //       namespace: knativeNamespace.metadata.name,
//     //     },
//     //   },
//     //   {
//     //     provider,
//     //   }
//     // );
//   });
// };
