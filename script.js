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
        success_url: "https://ry7y.github.io/success.html",
        cancel_url: "https://ry7y.github.io/cancel.html"
      })
    });

    if (!res.ok) {
      // فشل الاستجابة من السيرفر
      const errText = await res.text();
      status.innerText = "⚠️ خطأ من السيرفر: " + errText;
      return;
    }

    const data = await res.json();

    if (data.url) {
      status.innerText = "✅ جاري تحويلك لصفحة الدفع...";
      window.location.href = data.url;
    } else {
      status.innerText = "⚠️ لم يتم استلام رابط جلسة الدفع: " + JSON.stringify(data);
    }
  } catch (err) {
    status.innerText = "🚨 خطأ في الاتصال: " + err.message;
  }
});