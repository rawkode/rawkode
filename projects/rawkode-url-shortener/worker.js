const redirects = {
  "rawkode.link": {
    "office-hours": {
      to: "https://savvycal.com/rawkode/office-hours",
    },
  },
};

addEventListener("fetch", async (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const requestUrl = new URL(request.url);
  const domain = requestUrl.host;
  const path = requestUrl.pathname.substring(1);

  console.log(`Handling request on domain ${domain} for ${path}`);

  if (!domain in redirects) {
    console.log("DOmain not found");
    return Response.redirect("https://twitter.com/rawkode");
  }

  if (path == "" || !path in redirects[domain]) {
    console.log("path not found");
    return Response.redirect("https://twitter.com/rawkode");
  }

  console.log(`Redirecting too ${redirects[domain][path].to}`);
  return Response.redirect(redirects[domain][path].to);
}
