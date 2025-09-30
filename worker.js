export default {
  async fetch(request, env, ctx) {
    return new Response(
      JSON.stringify({ status: "ok", path: new URL(request.url).pathname }),
      { headers: { "Content-Type": "application/json" } }
    );
  }
}