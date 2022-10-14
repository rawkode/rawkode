import { createZone } from "./dnsProviders/cloudDns";

import { profundum } from "./domains/profundum.co.uk";
createZone(profundum);

import { rawkodeDev } from "./domains/rawkode.dev";
createZone(rawkodeDev);
