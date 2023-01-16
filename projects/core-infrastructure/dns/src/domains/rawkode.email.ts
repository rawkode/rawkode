import { Construct } from "constructs";
import { ManagedDomain } from "../dnsProvider";

export default (scope: Construct): ManagedDomain => {
	const managedDomain = new ManagedDomain(scope, "rawkode.email");

	managedDomain.enableFastmail();
	return managedDomain;
};
