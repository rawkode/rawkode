import { Controller } from "./controller";

import rawkode from "./rawko.de";
import rawkodeAcademy from "./rawkode.academy";
import rawkodeCommunity from "./rawkode.community";
import rawkodeChat from "./rawkode.chat";
import rawkodeCom from "./rawkode.com";
import rawkodeLink from "./rawkode.link";
import rawkodeDev from "./rawkode.dev";
import rawkodeEmail from "./rawkode.email";
import rawkodeLive from "./rawkode.live";
import rawkodeNews from "./rawkode.news";
import rawkodeSh from "./rawkode.sh";

export * from "./controller";

export const managedDomains = [
  rawkode,
  rawkodeAcademy,
  rawkodeChat,
  rawkodeCom,
  rawkodeDev,
  rawkodeLive,
  rawkodeSh,
];

export const getController = (name: string): Controller => {
  const domain = managedDomains.find((domain) => domain.domainName === name);

  if (!domain) {
    throw new Error(
      `Domain, ${name}, not found but requested by getController.`
    );
  }

  return domain;
};
