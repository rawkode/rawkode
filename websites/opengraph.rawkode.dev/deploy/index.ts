import * as gcp from '@pulumi/google-native';

const imageGenerator = new gcp.run.v1.Service('image-generator', {
	location: 'europe-west2',
	spec: {
		template: {
			spec: {
				containers: [
					{
						image: 'ghcr.io/rawkode/opengraph-image-generator:latest'
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

export const imageGeneratorUrl = imageGenerator.status.url;
