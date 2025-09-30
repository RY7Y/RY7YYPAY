document.getElementById("pay").addEventListener("click", async () => {
  const status = document.getElementById("status");
  status.innerText = "⏳ جاري إنشاء جلسة الدفع...";

  try {
    const res = await fetch("https://pay.devry7yy.org/create-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: 500, // 5.00 USD
        currency: "usd",
        description: "خدمة RY7 - تجربة",
        success_url: "https://devry7yy.org/success",
        cancel_url: "https://devry7yy.org/cancel"
      })
    });

    const data = await res.json();
    if (data.url) {
      status.innerText = "✅ جاري تحويلك لصفحة الدفع...";
      window.location.href = data.url;
    } else {
      status.innerText = "⚠️ خطأ: " + JSON.stringify(data);
    }
  } catch (err) {
    status.innerText = "🚨 خطأ في الاتصال: " + err.message;
  }
});