export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ✅ Telegram Webhook Endpoint
    if (url.pathname === "/telegram" && request.method === "POST") {
      try {
        const update = await request.json();

        // لو فيه رسالة
        if (update.message) {
          const chatId = update.message.chat.id;

          // لو فيه نص
          if (update.message.text) {
            const text = update.message.text;

            if (text === "/start") {
              await sendMessage(env.BOT_TOKEN, chatId, 
                "👋 أهلاً بك!\n\nأرسل لي ملف IPA أو صورة وسأحفظها لك 📲"
              );
            } else {
              await sendMessage(env.BOT_TOKEN, chatId, `📩 رسالتك: ${text}`);
            }
          }

          // لو فيه صورة
          if (update.message.photo) {
            const fileId = update.message.photo.pop().file_id;
            const fileInfo = await getFile(env.BOT_TOKEN, fileId);
            const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileInfo.file_path}`;

            await sendMessage(env.BOT_TOKEN, chatId, 
              `📸 تم استلام الصورة!\n\nرابط التحميل المباشر:\n${fileUrl}`
            );
          }

          // لو فيه ملف (IPA أو ZIP أو غيره)
          if (update.message.document) {
            const fileId = update.message.document.file_id;
            const fileName = update.message.document.file_name || "file";
            const fileInfo = await getFile(env.BOT_TOKEN, fileId);
            const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileInfo.file_path}`;

            await sendMessage(env.BOT_TOKEN, chatId, 
              `📦 تم استلام الملف: ${fileName}\n\nرابط التحميل المباشر:\n${fileUrl}`
            );
          }
        }

        return new Response("OK", { status: 200 });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // ✅ صفحة اختبار
    if (url.pathname === "/" || url.pathname === "") {
      return new Response("RY7YY Telegram Bot 🚀 شغال", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};

/// ✅ دوال مساعدة
async function sendMessage(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
    }),
  });
}

async function getFile(token, fileId) {
  const resp = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const data = await resp.json();
  if (!data.ok) throw new Error("Failed to fetch file info");
  return data.result;
}