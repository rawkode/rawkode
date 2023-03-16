import { Construct } from "constructs";
import { ManagedDomain } from "../dnsProvider";

export default (scope: Construct): ManagedDomain => {
	const managedDomain = new ManagedDomain(scope, "rawkode.dev");

	managedDomain.enableFastmail().addARecord("@", "3.13.222.255");

	return managedDomain;
};
