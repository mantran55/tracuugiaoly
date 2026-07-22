let appPromise;

async function getApp() {
  globalThis.__CLOUDFLARE_WORKER__ = true;
  if (!appPromise) appPromise = import("./server.js").then(module => module.default);
  return appPromise;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "access-control-allow-headers": "Content-Type, X-Automation-Secret, X-Automation-Key"
      }});
    }
    Object.assign(process.env, env);
    const app = await getApp();
    return app.fetch(request);
  }
};
