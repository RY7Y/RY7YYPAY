export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Endpoint لإنشاء جلسة دفع
    if (request.method === "POST" && url.pathname === "/create-checkout") {
      try {
        const body = await request.json();

        const params = new URLSearchParams();
        params.append("mode", "payment");
        params.append("payment_method_types[]", "card");
        params.append("line_items[0][price_data][currency]", body.currency || "usd");
        params.append("line_items[0][price_data][product_data][name]", body.description || "منتج تجريبي");
        params.append("line_items[0][price_data][unit_amount]", String(body.amount || 500));
        params.append("line_items[0][quantity]", String(body.quantity || 1));
        params.append("success_url", body.success_url || "https://devry7yy.org/success");
        params.append("cancel_url", body.cancel_url || "https://devry7yy.org/cancel");

        const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params.toString(),
        });

        const data = await resp.json();
        return new Response(JSON.stringify(data), {
          status: resp.status,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // أي مسار ثاني
    return new Response("Not Found", { status: 404 });
  },
};