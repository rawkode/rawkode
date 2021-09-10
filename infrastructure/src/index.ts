import { managedZones } from "./dns";

// hack to stop the compiler eliding the import
const f = managedZones;
