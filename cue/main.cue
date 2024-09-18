package main

deployment: klustered: {
	apiVersion: "apps/v1"
	kind:       "Deployment"
	metadata: name: "klustered"
	spec: {
		selector: matchLabels: app: "klustered"
		template: {
			metadata: labels: app: "klustered"
			spec: containers: [{
				name:            "klustered"
				image:           "ghcr.io/rawkodeacademy/klustered:v1"
				imagePullPolicy: "Always"
				resources: limits: {
					memory: "128Mi"
					cpu:    "500m"
				}
			}]
		}
	}
}
configMap: postgresql: {
	apiVersion: "v1"
	kind:       "ConfigMap"
	metadata: name: "postgresql"
	data: "init.sh": """
		#!/bin/bash
		set -e

		psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
		    CREATE TABLE IF NOT EXISTS quotes (
		        quote VARCHAR ( 5000 ) UNIQUE NOT NULL,
		        author VARCHAR ( 500 ) NOT NULL,
		        link VARCHAR ( 512 ) NOT NULL
		    );
		    INSERT INTO quotes (quote, author, link)
		    VALUES
		        ('May your bag be bountiful and your success be great. p.s. you''re v smart and hot', 'Stephen Augustus', 'https://twitter.com/stephenaugustus/status/1372193744078958595'),
		        ('Fight for your limits and sure enough their yours', 'Duffie''s Mom', 'https://twitter.com/mauilion/status/1373485025585340418'),
		        ('Productivity does not determine your value. You have value in just being you.', 'Katy Farmer', 'https://twitter.com/TheKaterTot/status/1370511659677089794');
		EOSQL

		"""
}
service: postgres: {
	apiVersion: "v1"
	kind:       "Service"
	metadata: name: "postgres"
	spec: {
		selector: app: "postgresql"
		ports: [{port: 5432}]
	}
}
statefulSet: postgresql: {
	apiVersion: "apps/v1"
	kind:       "StatefulSet"
	metadata: name: "postgresql"
	spec: {
		selector: matchLabels: app: "postgresql"
		serviceName: "postgresql"
		replicas:    1
		template: {
			metadata: labels: app: "postgresql"
			spec: {
				volumes: [{
					name: "init"
					configMap: name: "postgresql"
				}]
				containers: [{
					name:            "postgresql"
					image:           "postgres:13-alpine"
					imagePullPolicy: "IfNotPresent"
					livenessProbe: {
						exec: command: [
							"/bin/sh",
							"-c",
							"exec pg_isready -U \"postgres\" -h 127.0.0.1 -p 5432",
						]
						failureThreshold:    2
						initialDelaySeconds: 5
						periodSeconds:       5
						successThreshold:    1
						timeoutSeconds:      5
					}
					readinessProbe: {
						exec: command: [
							"/bin/sh",
							"-c",
							"exec pg_isready -U \"postgres\" -h 127.0.0.1 -p 5432",
						]
						failureThreshold:    2
						initialDelaySeconds: 5
						periodSeconds:       5
						successThreshold:    1
						timeoutSeconds:      5
					}
					volumeMounts: [{
						mountPath: "/docker-entrypoint-initdb.d"
						name:      "init"
					}]
					env: [{
						name:  "POSTGRES_USER"
						value: "postgres"
					}, {
						name:  "POSTGRES_DB"
						value: "klustered"
					}, {
						name:  "POSTGRES_PASSWORD"
						value: "postgresql123"
					}]
					ports: [{
						containerPort: 5432
						name:          "psql"
					}]
				}]
			}
		}
	}
}
configMap: postgresql: {
	apiVersion: "v1"
	kind:       "ConfigMap"
	metadata: name: "postgresql"
	data: "init.sh": """
		#!/bin/bash
		set -e

		psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
		    CREATE TABLE IF NOT EXISTS quotes (
		        quote VARCHAR ( 5000 ) UNIQUE NOT NULL,
		        author VARCHAR ( 500 ) NOT NULL,
		        link VARCHAR ( 512 ) NOT NULL
		    );
		    INSERT INTO quotes (quote, author, link)
		    VALUES
		        ('May your bag be bountiful and your success be great. p.s. you''re v smart and hot', 'Stephen Augustus', 'https://twitter.com/stephenaugustus/status/1372193744078958595'),
		        ('Fight for your limits and sure enough their yours', 'Duffie''s Mom', 'https://twitter.com/mauilion/status/1373485025585340418'),
		        ('Productivity does not determine your value. You have value in just being you.', 'Katy Farmer', 'https://twitter.com/TheKaterTot/status/1370511659677089794');
		EOSQL

		"""
}
service: postgres: {
	apiVersion: "v1"
	kind:       "Service"
	metadata: name: "postgres"
	spec: {
		selector: app: "postgresql"
		ports: [{port: 5432}]
	}
}
statefulSet: postgresql: {
	apiVersion: "apps/v1"
	kind:       "StatefulSet"
	metadata: name: "postgresql"
	spec: {
		selector: matchLabels: app: "postgresql"
		serviceName: "postgresql"
		replicas:    1
		template: {
			metadata: labels: app: "postgresql"
			spec: {
				volumes: [{
					name: "init"
					configMap: name: "postgresql"
				}]
				containers: [{
					name:            "postgresql"
					image:           "postgres:13-alpine"
					imagePullPolicy: "IfNotPresent"
					livenessProbe: {
						exec: command: [
							"/bin/sh",
							"-c",
							"exec pg_isready -U \"postgres\" -h 127.0.0.1 -p 5432",
						]
						failureThreshold:    2
						initialDelaySeconds: 5
						periodSeconds:       5
						successThreshold:    1
						timeoutSeconds:      5
					}
					readinessProbe: {
						exec: command: [
							"/bin/sh",
							"-c",
							"exec pg_isready -U \"postgres\" -h 127.0.0.1 -p 5432",
						]
						failureThreshold:    2
						initialDelaySeconds: 5
						periodSeconds:       5
						successThreshold:    1
						timeoutSeconds:      5
					}
					volumeMounts: [{
						mountPath: "/docker-entrypoint-initdb.d"
						name:      "init"
					}]
					env: [{
						name:  "POSTGRES_USER"
						value: "postgres"
					}, {
						name:  "POSTGRES_DB"
						value: "klustered"
					}, {
						name:  "POSTGRES_PASSWORD"
						value: "postgresql123"
					}]
					ports: [{
						containerPort: 5432
						name:          "psql"
					}]
				}]
			}
		}
	}
}
