import { Construct } from "constructs";
import { ManagedDomain } from "../dnsProvider";

export default (scope: Construct): ManagedDomain => {
	const managedDomain = new ManagedDomain(scope, "profundum.co.uk");

	managedDomain.enableGSuite();

	return managedDomain;
};
