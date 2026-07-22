/** A small Express-compatible router that runs on the Workers Fetch API. */
function createApp() {
  const routes = [];
  const app = {};

  for (const method of ["get", "post", "put", "delete", "patch"]) {
    app[method] = (pattern, handler) => {
      routes.push({ method: method.toUpperCase(), pattern, handler });
      return app;
    };
  }

  app.use = () => app;
  app.listen = () => { throw new Error("Use `npm run dev` to run the Worker."); };

  app.fetch = async request => {
    const url = new URL(request.url);
    const match = routes.find(route => {
      if (route.method !== request.method) return false;
      const routeParts = route.pattern.split("/").filter(Boolean);
      const pathParts = url.pathname.split("/").filter(Boolean);
      return routeParts.length === pathParts.length && routeParts.every((part, index) => part.startsWith(":") || part === pathParts[index]);
    });
    if (!match) return json({ success: false, error: "Not found" }, 404);

    const routeParts = match.pattern.split("/").filter(Boolean);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const params = {};
    routeParts.forEach((part, index) => { if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(pathParts[index]); });

    let body = {};
    if (["POST", "PUT", "PATCH"].includes(request.method) && (request.headers.get("content-type") || "").includes("application/json")) {
      try { body = await request.json(); } catch { body = {}; }
    }

    let response;
    const streamed = [];
    const responseHeaders = new Headers();
    const res = {
      status(code) { this.statusCode = code; return this; },
      json(data) { response = json(data, this.statusCode || 200); return response; },
      send(data) { response = new Response(data, { status: this.statusCode || 200, headers: corsHeaders({ "content-type": "text/plain; charset=utf-8" }) }); return response; },
      setHeader(name, value) { responseHeaders.set(name, value); },
      flushHeaders() {},
      write(data) { streamed.push(String(data)); },
      end() { response = new Response(streamed.join(""), { status: this.statusCode || 200, headers: corsHeaders(responseHeaders) }); }
    };
    try {
      await match.handler({ query: Object.fromEntries(url.searchParams), params, body, headers: request.headers }, res);
      return response || json({ success: false, error: "Route did not return a response" }, 500);
    } catch (error) {
      console.error(error);
      return json({ success: false, error: error.message || "Internal server error" }, error.status || 500);
    }
  };
  return app;
}

function corsHeaders(headers = {}) {
  return new Headers({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "Content-Type, X-Automation-Secret",
    ...headers
  });
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders({ "content-type": "application/json; charset=utf-8" }) });
}
createApp.json = () => () => {};
module.exports = createApp;
