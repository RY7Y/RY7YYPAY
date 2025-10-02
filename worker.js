export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/telegram" && request.method === "POST") {
      try {
        const update = await request.json();
        console.log("📩 Update:", JSON.stringify(update, null, 2));

        if (update.message) {
          const chatId = update.message.chat.id;

          // نص
          if (update.message.text) {
            if (update.message.text === "/start") {
              await sendMessage(env.BOT_TOKEN, chatId,
                "👋 أهلاً بك في بوت RY7YY\n\n📲 أرسل لي ملف IPA أو صورة وسأعطيك رابط مباشر للتحميل.\n\n✨ مميزات:\n- يدعم الصور\n- يدعم الملفات (IPA, ZIP, PDF...)\n- روابط مباشرة للتحميل"
              );
            } else {
              await sendMessage(env.BOT_TOKEN, chatId, `📩 استلمت رسالتك:\n${update.message.text}`);
            }
          }

          // صور
          if (update.message.photo) {
            const fileId = update.message.photo.pop().file_id;
            const fileInfo = await getFile(env.BOT_TOKEN, fileId);
            const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileInfo.file_path}`;
            await sendMessage(env.BOT_TOKEN, chatId, `📸 الصورة جاهزة!\n${fileUrl}`);
          }

          // ملفات (IPA, ZIP...)
          if (update.message.document) {
            const fileId = update.message.document.file_id;
            const fileName = update.message.document.file_name || "ملف";
            const fileInfo = await getFile(env.BOT_TOKEN, fileId);
            const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileInfo.file_path}`;
            await sendMessage(env.BOT_TOKEN, chatId,
              `📦 تم استلام الملف: ${fileName}\n🔗 رابط التحميل:\n${fileUrl}`
            );
          }
        }

        return new Response("OK", { status: 200 });
      } catch (err) {
        console.error("❌ Error:", err);
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response("RY7YY Bot 🚀 يعمل الآن", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};

async function sendMessage(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function getFile(token, fileId) {
  const resp = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const data = await resp.json();
  if (!data.ok) throw new Error("Failed to fetch file info");
  return data.result;
}