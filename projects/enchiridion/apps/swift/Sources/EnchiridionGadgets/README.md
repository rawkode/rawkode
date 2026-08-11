# EnchiridionGadgets

The native WKWebView capability bridge. It is a bounded adapter: the service
remains authoritative for every capability, and device-side checks are only
defence in depth. Device accessibility and runtime evidence are required
before enabling this surface in production.
