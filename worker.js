export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const BOT_TOKEN = env.BOT_TOKEN;
    const CHANNEL_USERNAME = env.CHANNEL_USERNAME || "RY7DY"; // بدون @
    if (!BOT_TOKEN) return json({ error: "Missing BOT_TOKEN" }, 500);

    // تنزيل باسم مخصص عبر توكن مؤقت (لا يدمج الصورة بالملف؛ فقط يعيد تسمية عند التنزيل)
    if (url.pathname.startsWith("/d/")) {
      const token = url.pathname.split("/d/")[1];
      if (!token) return new Response("Bad token", { status: 400 });

      const pack = await env.SESSION_KV.get(`dl:${token}`, { type: "json" });
      if (!pack) return new Response("Link expired", { status: 404 });

      const tgUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${pack.ipa_path}`;
      const tgResp = await fetch(tgUrl);
      if (!tgResp.ok) return new Response("Source fetch failed", { status: 502 });

      const headers = new Headers(tgResp.headers);
      headers.set(
        "Content-Disposition",
        `attachment; filename="${sanitizeFilename(pack.filename || "app.ipa")}"`
      );
      return new Response(tgResp.body, { status: 200, headers });
    }

    // Webhook تيليجرام
    if (url.pathname === "/telegram" && request.method === "POST") {
      const update = await request.json().catch(() => null);
      if (!update) return json({ ok: false, error: "Invalid update" }, 400);

      const msg = update.message || update.edited_message;
      if (!msg) return json({ ok: true });

      const chatId = msg.chat.id;
      const userId = msg.from?.id;

      // تحقّق اشتراك القناة
      const subscribed = await isMember(BOT_TOKEN, CHANNEL_USERNAME, userId);
      if (!subscribed) {
        await sendMessage(
          BOT_TOKEN,
          chatId,
          `👋 لاستخدام البوت يرجى الاشتراك أولاً:
📣 https://t.me/${CHANNEL_USERNAME}

ثم أرسل /start.`
        );
        return json({ ok: true });
      }

      // حالة المستخدم
      let state =
        (await env.SESSION_KV.get(`state:${chatId}`, { type: "json" })) || {
          step: "awaiting_ipa", // awaiting_ipa -> awaiting_image -> awaiting_name
          ipa_file_id: null,
          ipa_path: null,
          image_file_id: null,
          image_path: null,
          filename: null
        };

      // أوامر عامة
      if (msg.text === "/reset") {
        await env.SESSION_KV.delete(`state:${chatId}`);
        await sendMessage(BOT_TOKEN, chatId, "🔄 تم تصفير الجلسة. أرسل /start للبدء.");
        return json({ ok: true });
      }

      if (msg.text === "/start") {
        state = {
          step: "awaiting_ipa",
          ipa_file_id: null,
          ipa_path: null,
          image_file_id: null,
          image_path: null,
          filename: null
        };
        await env.SESSION_KV.put(`state:${chatId}`, JSON.stringify(state));
        await sendMessage(
          BOT_TOKEN,
          chatId,
          `👋 أهلاً بك في بوت RY7YY IPA!

الخطوات:
1) أرسل ملف IPA (حتى ~2GB).
2) أرسل صورة تُعرض كأيقونة داخل تيليجرام.
3) أرسل اسم الملف المطلوب (مثل: RY7YY.ipa)

سنُعيد لك الملف داخل تيليجرام **مع الأيقونة** (بدون توقيع). يمكنك توقيعه لاحقًا عبر TrollStore أو Esign.`
        );
        return json({ ok: true });
      }

      // استقبال IPA
      if (msg.document && state.step === "awaiting_ipa") {
        const doc = msg.document;
        if (!/\.ipa$/i.test(doc.file_name || "")) {
          await sendMessage(BOT_TOKEN, chatId, "⚠️ رجاءً أرسل ملف بصيغة .ipa");
          return json({ ok: true });
        }
        if ((doc.file_size || 0) > 2 * 1024 * 1024 * 1024) {
          await sendMessage(BOT_TOKEN, chatId, "❌ الحجم كبير. السقف ~2GB عبر تيليجرام.");
          return json({ ok: true });
        }

        const fileInfo = await getFile(BOT_TOKEN, doc.file_id);
        state.ipa_file_id = doc.file_id;
        state.ipa_path = fileInfo.file_path;
        state.step = "awaiting_image";
        await env.SESSION_KV.put(`state:${chatId}`, JSON.stringify(state));
        await sendMessage(BOT_TOKEN, chatId, "✅ تم استلام الـIPA.\nأرسل الآن *صورة* للأيقونة.", "Markdown");
        return json({ ok: true });
      }

      // استقبال صورة
      if (msg.photo && state.step === "awaiting_image") {
        const bestPhoto = msg.photo[msg.photo.length - 1];
        const fileInfo = await getFile(BOT_TOKEN, bestPhoto.file_id);

        state.image_file_id = bestPhoto.file_id;
        state.image_path = fileInfo.file_path;
        state.step = "awaiting_name";
        await env.SESSION_KV.put(`state:${chatId}`, JSON.stringify(state));
        await sendMessage(BOT_TOKEN, chatId, "✅ تم استلام الصورة.\nأرسل اسم الملف المطلوب مثل: `RY7YY.ipa`", "Markdown");
        return json({ ok: true });
      }

      // استقبال اسم الملف ثم: (1) روابط مباشرة, (2) إرسال الملف داخل تيليجرام مع الأيقونة
      if (msg.text && state.step === "awaiting_name") {
        const desired = (msg.text || "").trim();
        if (!/\.ipa$/i.test(desired)) {
          await sendMessage(BOT_TOKEN, chatId, "⚠️ اسم غير صالح. يجب أن ينتهي بـ .ipa");
          return json({ ok: true });
        }
        state.filename = desired;

        // 1) اصنع رابط تنزيل بالاسم الجديد (ساري 10 دقائق)
        const token = cryptoRandomId();
        await env.SESSION_KV.put(
          `dl:${token}`,
          JSON.stringify({ ipa_path: state.ipa_path, filename: state.filename }),
          { expirationTtl: 600 }
        );
        const renamedDownload = `${url.origin}/d/${token}`;
        const imageDirect = `https://api.telegram.org/file/bot${BOT_TOKEN}/${state.image_path}`;

        // رسالة تجهيز
        const prepping = await sendMessage(
          BOT_TOKEN,
          chatId,
          `⏳ تجهيز الملف وإرسال نسخة داخل تيليجرام مع الأيقونة...\n\n🔗 تنزيل بالاسم الجديد: ${renamedDownload}\n📸 رابط الصورة: ${imageDirect}`
        );

        // 2) إعادة رفع الملف داخل تيليجرام + thumbnail (بث متدفق)
        try {
          await sendDocumentWithThumbnail({
            botToken: BOT_TOKEN,
            chatId,
            ipaPath: state.ipa_path,
            imagePath: state.image_path,
            filename: state.filename
          });

          await editMessageText(
            BOT_TOKEN,
            chatId,
            prepping.message_id,
            `✅ تم الإرسال!\n\n🔗 تنزيل بالاسم الجديد: ${renamedDownload}\n📸 الصورة: ${imageDirect}\n\nملاحظة: الملف غير موقّع – يمكنك توقيعه عبر TrollStore أو Esign.`
          );
        } catch (e) {
          await editMessageText(
            BOT_TOKEN,
            chatId,
            prepping.message_id,
            `⚠️ أرسلنا الروابط بنجاح، لكن رفع النسخة داخل تيليجرام فشل: ${e.message}\nيمكنك استخدام رابط التنزيل بالأعلى.`
          );
        }

        // انهِ الجلسة
        await env.SESSION_KV.delete(`state:${chatId}`);
        return json({ ok: true });
      }

      // رد افتراضي
      if (msg.text && !["/start", "/reset"].includes(msg.text)) {
        await sendMessage(BOT_TOKEN, chatId, "ℹ️ اكتب /start للبدء أو /reset لإعادة الضبط.");
      }

      return json({ ok: true });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response("RY7YY Telegram Bot ✅", { status: 200 });
    }
    return new Response("Not Found", { status: 404 });
  }
};

/* =================== أدوات مساعدة =================== */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function cryptoRandomId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function isMember(token, channelUserName, userId) {
  const url = `https://api.telegram.org/bot${token}/getChatMember?chat_id=@${channelUserName}&user_id=${userId}`;
  const resp = await fetch(url);
  const data = await resp.json().catch(() => ({}));
  if (!data.ok) return false;
  const st = data.result?.status;
  return ["creator", "administrator", "member"].includes(st);
}

async function sendMessage(token, chatId, text, parseMode) {
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await resp.json().catch(() => ({}));
  return data.result || {};
}

async function editMessageText(token, chatId, messageId, text) {
  await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text })
  });
}

async function getFile(token, fileId) {
  const resp = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const data = await resp.json();
  if (!data.ok) throw new Error("Failed to fetch file info");
  return data.result;
}

/**
 * يرسل sendDocument مع thumbnail بالرفع المتدفق (stream)
 * بدون حفظ الملف في الذاكرة.
 */
async function sendDocumentWithThumbnail({ botToken, chatId, ipaPath, imagePath, filename }) {
  const ipaUrl = `https://api.telegram.org/file/bot${botToken}/${ipaPath}`;
  const imgUrl = `https://api.telegram.org/file/bot${botToken}/${imagePath}`;

  const ipaResp = await fetch(ipaUrl);
  if (!ipaResp.ok || !ipaResp.body) throw new Error("Failed to fetch IPA stream");

  const imgResp = await fetch(imgUrl);
  if (!imgResp.ok || !imgResp.body) throw new Error("Failed to fetch image stream");

  const boundary = "----RY7YYBoundary" + cryptoRandomId();
  const encoder = new TextEncoder();

  // دوال صغيرة لبناء أجزاء multipart
  const partHeader = (name, filename, contentType) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename ? `; filename="${filename}"` : ""}\r\n${contentType ? `Content-Type: ${contentType}\r\n` : ""}\r\n`;

  const tail = `\r\n--${boundary}--\r\n`;

  // نبني ReadableStream يرسل:
  // [حقول نصية] -> [هيدر IPA] + باينري IPA -> [هيدر thumbnail] + باينري الصورة -> [ذيل]
  const bodyStream = new ReadableStream({
    async start(controller) {
      // حقول نصية
      controller.enqueue(encoder.encode(partHeader("chat_id") + chatId + "\r\n"));
      controller.enqueue(encoder.encode(partHeader("caption") + "📦 نسخة بالداخل مع الأيقونة (بدون توقيع)\r\n"));
      // أحيانًا تيليجرام يطلب thumb/thumbnail؛ نرسل لاحقًا مع الصورة كملف ثانٍ.

      // ملف IPA
      controller.enqueue(encoder.encode(partHeader("document", sanitizeFilename(filename || "app.ipa"), "application/octet-stream")));
      await pipeStream(ipaResp.body, controller);
      controller.enqueue(encoder.encode("\r\n"));

      // الصورة كـ thumbnail (نرسل كلا الاسمين للتوافق)
      controller.enqueue(encoder.encode(partHeader("thumbnail", "thumb.jpg", "image/jpeg")));
      await pipeStream(imgResp.body, controller);
      controller.enqueue(encoder.encode("\r\n"));

      controller.enqueue(encoder.encode(partHeader("thumb", "thumb.jpg", "image/jpeg")));
      // نحتاج إعادة تيار الصورة مرة ثانية للاسم الآخر؛ لذا نعيد جلبه بسرعة:
      const imgResp2 = await fetch(imgUrl);
      await pipeStream(imgResp2.body, controller);
      controller.enqueue(encoder.encode("\r\n"));

      // نهاية
      controller.enqueue(encoder.encode(tail));
      controller.close();
    }
  });

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: bodyStream
  });

  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    throw new Error(`sendDocument failed: ${data.description || res.status}`);
  }
}

async function pipeStream(srcReadable, controller) {
  const reader = srcReadable.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    controller.enqueue(value);
  }
}