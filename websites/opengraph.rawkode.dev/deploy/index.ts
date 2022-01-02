import * as pulumi from '@pulumi/pulumi';
import * as docker from '@pulumi/docker';
import * as gcp from '@pulumi/google-native';

const containerImage = new docker.Image('opengraph', {
	imageName: pulumi.interpolate`gcr.io/${gcp.config.project}/opengraph-image-generator:latest`,
	build: {
		context: '../functions/image-generator'
	}
});

const imageGenerator = new gcp.run.v1.Service('image-generator', {
	kind: 'Service',
	apiVersion: 'serving.knative.dev/v1',
	metadata: {
		name: 'opengraph-image-generator'
	},
	location: 'europe-west2',
	spec: {
		template: {
			spec: {
				containers: [
					{
						image: containerImage.imageName
					}
				]
			}
		},

		traffic: [
			{
				latestRevision: true,
				percent: 100
			}
		]
	}
});

const imageGeneratorPolicy = new gcp.run.v1.ServiceIamPolicy('image-generator', {
	serviceId: imageGenerator.id,
	location: 'europe-west2',
	bindings: [
		{
			members: ['allUsers'],
			role: 'roles/run.invoker'
		}
	]
});

export const imageGeneratorUrl = imageGenerator.status.url;
