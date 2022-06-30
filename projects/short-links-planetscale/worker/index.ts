interface Redirect {
  to: string;
}

interface Redirects {
  [domain: string]: {
    [path: string]: Redirect;
  };
}

const redirects: Redirects = {
  "rawkode.link": {
    "office-hours": {
      to: "https://savvycal.com/rawkode/office-hours",
    },
  },
};

addEventListener("fetch", async (event: FetchEvent) => {
  event.respondWith(handleRequest(event.request));

  console.log(`I am the analytics request, post response`);
});

async function handleRequest(request: Request) {
  const requestUrl = new URL(request.url);
  const domain = requestUrl.host;
  const path = requestUrl.pathname.substring(1);

  console.log(`Handling request on domain ${domain} for ${path}`);

  if (!(domain in redirects)) {
    console.log("Domain not found");
    return Response.redirect("https://twitter.com/rawkode");
  }

  console.log("Domain found");

  if (path === "") {
    console.log("Path empty");
    return Response.redirect("https://twitter.com/rawkode");
  }

  const paths = redirects[domain];

  if (path in paths) {
    console.log(`Path, ${path}, found in ${paths}`);

    console.log(`Redirecting too ${paths[path].to}`);
    return Response.redirect(paths[path].to);
  }

  console.log("Path not found");
  return Response.redirect("https://twitter.com/rawkode");
}
