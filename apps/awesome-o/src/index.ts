import * as pulumi from "@pulumi/pulumi";
import * as metal from "@pulumi/equinix-metal";

const config = new pulumi.Config();
const projectId = config.require("projectID");

const userData = `#!/usr/bin/env sh
curl https://get.comtrya.dev | sh
comtrya https://github.com/rawkode/rawkode#main:apps/awesome-o/opt/comtrya
`;

const k3sDevice = new metal.Device("k3s", {
	hostname: "awesome-o",
	billingCycle: metal.BillingCycle.Hourly,
	operatingSystem: metal.OperatingSystem.Ubuntu2004,
	plan: metal.Plan.C2MediumX86,
	metro: "am",
	projectId,
	userData,
});
