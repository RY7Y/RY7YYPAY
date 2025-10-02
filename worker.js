export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ====== الإعدادات ======
    const BOT_TOKEN = env.BOT_TOKEN;                                  // (إلزامي)
    const CHANNEL_USERNAME = String(env.CHANNEL_USERNAME || "RY7DY")  // بدون @
      .replace(/^@/, "");
    const OWNER_IDS = parseOwnerIds(env.OWNER_IDS);                   // مثال: "12345678,87654321"
    const BOT_UPLOAD_LIMIT = Number(env.BOT_UPLOAD_LIMIT_BYTES || 48 * 1024 * 1024); // حد رفع multipart التقريبي

    if (!BOT_TOKEN) return json({ error: "Missing BOT_TOKEN" }, 500);

    // ====== تنزيل باسم مخصص عبر توكن مؤقت ======
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

    // ====== Webhook تيليجرام ======
    if (url.pathname === "/telegram" && request.method === "POST") {
      const update = await request.json().catch(() => null);

      console.log("📩 Telegram Update:", JSON.stringify(update, null, 2));

      if (!update) return json({ ok: false, error: "Invalid update" }, 400);

      const msg = update.message || update.edited_message;
      if (!msg) return json({ ok: true });

      const chatId = msg.chat.id;
      const userId = msg.from?.id;

      // ✅ التحقق من الاشتراك
      const allowed = await isAllowedUser({
        token: BOT_TOKEN,
        channelUserName: CHANNEL_USERNAME,
        userId,
        ownerIds: OWNER_IDS
      });

      if (!allowed) {
        await sendMessage(
          BOT_TOKEN,
          chatId,
          `👋 لاستخدام البوت يرجى الاشتراك أولاً:\n📣 https://t.me/${CHANNEL_USERNAME}\n\nثم أرسل /start.`
        );
        return json({ ok: true });
      }

      // ====== حالة/جلسة المستخدم ======
      let state =
        (await env.SESSION_KV.get(`state:${chatId}`, { type: "json" })) || {
          step: "awaiting_ipa",
          ipa_file_id: null,
          ipa_path: null,
          ipa_size: 0,
          image_file_id: null,
          image_path: null,
          filename: null
        };

      // ====== أوامر عامة ======
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
          ipa_size: 0,
          image_file_id: null,
          image_path: null,
          filename: null
        };
        await env.SESSION_KV.put(`state:${chatId}`, JSON.stringify(state));
        await sendMessage(
          BOT_TOKEN,
          chatId,
          `👋 أهلاً بك في بوت RY7YY IPA!

📌 الخطوات:
1️⃣ أرسل ملف IPA (أي حجم).
2️⃣ أرسل صورة/Thumbnail.
3️⃣ أرسل اسم الملف المطلوب (مثل: RY7YY.ipa).`
        );
        return json({ ok: true });
      }

      // ====== استقبال IPA ======
      if (msg.document && state.step === "awaiting_ipa") {
        const doc = msg.document;
        if (!/\.ipa$/i.test(doc.file_name || "")) {
          await sendMessage(BOT_TOKEN, chatId, "⚠️ رجاءً أرسل ملف بصيغة .ipa");
          return json({ ok: true });
        }

        // ⚠️ تعديل مهم: إذا كان الملف كبير → لا تستخدم getFile
        if (doc.file_size > BOT_UPLOAD_LIMIT) {
          state.ipa_file_id = doc.file_id;
          state.ipa_size = Number(doc.file_size || 0);
          state.step = "awaiting_image";
          await env.SESSION_KV.put(`state:${chatId}`, JSON.stringify(state));
          await sendMessage(
            BOT_TOKEN,
            chatId,
            `⚠️ الملف كبير (${formatBytes(state.ipa_size)}). سيتم التعامل معه عبر file_id فقط.`
          );
          await sendMessage(BOT_TOKEN, chatId, "📸 الآن أرسل صورة (ستظهر كأيقونة فقط).");
          return json({ ok: true });
        }

        // الملف ضمن الحدود → نستخدم getFile
        const fileInfo = await getFile(BOT_TOKEN, doc.file_id);
        state.ipa_file_id = doc.file_id;
        state.ipa_path = fileInfo.file_path;
        state.ipa_size = Number(doc.file_size || 0);
        state.step = "awaiting_image";
        await env.SESSION_KV.put(`state:${chatId}`, JSON.stringify(state));

        await sendMessage(
          BOT_TOKEN,
          chatId,
          `✅ تم حفظ ملف IPA (${formatBytes(state.ipa_size)}).`
        );
        await sendMessage(BOT_TOKEN, chatId, "📸 الآن أرسل صورة (ستظهر كأيقونة داخل تيليجرام فقط).");
        return json({ ok: true });
      }

      // ====== استقبال صورة ======
      if (msg.photo && state.step === "awaiting_image") {
        const bestPhoto = msg.photo[msg.photo.length - 1];
        const fileInfo = await getFile(BOT_TOKEN, bestPhoto.file_id).catch(() => null);

        state.image_file_id = bestPhoto.file_id;
        state.image_path = fileInfo?.file_path || null;
        state.step = "awaiting_name";
        await env.SESSION_KV.put(`state:${chatId}`, JSON.stringify(state));

        await sendMessage(BOT_TOKEN, chatId, "✅ تم حفظ الصورة.");
        await sendMessage(BOT_TOKEN, chatId, "✍️ أرسل الآن اسم الملف مثل: `RY7YY.ipa`", "Markdown");
        return json({ ok: true });
      }

      // ====== استقبال الاسم ======
      if (msg.text && state.step === "awaiting_name") {
        const desired = (msg.text || "").trim();
        if (!/\.ipa$/i.test(desired)) {
          await sendMessage(BOT_TOKEN, chatId, "⚠️ الاسم غير صالح. يجب أن ينتهي بـ .ipa");
          return json({ ok: true });
        }
        state.filename = desired;

        const token = cryptoRandomId();
        await env.SESSION_KV.put(
          `dl:${token}`,
          JSON.stringify({ ipa_path: state.ipa_path, filename: state.filename }),
          { expirationTtl: 600 }
        );
        const renamedDownload = `${url.origin}/d/${token}`;

        const prep = await sendMessage(
          BOT_TOKEN,
          chatId,
          `⏳ جاري التحضير...\n🔗 رابط التنزيل بالاسم الجديد: ${renamedDownload}`
        );

        try {
          if (state.ipa_size && state.ipa_size <= BOT_UPLOAD_LIMIT && state.ipa_path) {
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
              prep.message_id,
              `✅ تم الإرسال داخل تيليجرام بالاسم الجديد.\n🔗 أيضًا: ${renamedDownload}`
            );
          } else {
            await editMessageText(
              BOT_TOKEN,
              chatId,
              prep.message_id,
              `ℹ️ الملف كبير جدًا لرفع جديد.\n🔗 حمّل بالاسم الجديد: ${renamedDownload}`
            );

            await sendDocumentByFileId({
              botToken: BOT_TOKEN,
              chatId,
              fileId: state.ipa_file_id,
              caption: "📦 نسخة داخل تيليجرام (قد يظهر الاسم الأصلي)."
            });
          }
        } catch (e) {
          await editMessageText(
            BOT_TOKEN,
            chatId,
            prep.message_id,
            `⚠️ تعذّر الإرسال داخل تيليجرام: ${e.message}\n🔗 ${renamedDownload}`
          );
        }

        await env.SESSION_KV.delete(`state:${chatId}`);
        return json({ ok: true });
      }

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

/* =================== الأدوات المساعدة =================== */
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
function parseOwnerIds(raw) {
  if (!raw) return new Set();
  return new Set(
    String(raw).split(",").map(s => Number(s.trim())).filter(n => Number.isFinite(n))
  );
}
function formatBytes(n) {
  if (!n || n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
}
async function sleep(ms) { await new Promise(r => setTimeout(r, ms)); }

async function isAllowedUser({ token, channelUserName, userId, ownerIds }) {
  try {
    if (ownerIds && ownerIds.has(Number(userId))) return true;
    const url = `https://api.telegram.org/bot${token}/getChatMember?chat_id=@${channelUserName}&user_id=${userId}`;
    const resp = await fetch(url);
    const data = await resp.json().catch(() => ({}));
    if (!data.ok) return ownerIds && ownerIds.has(Number(userId));
    const st = data.result?.status;
    return ["creator", "administrator", "member"].includes(st);
  } catch {
    return ownerIds && ownerIds.has(Number(userId));
  }
}

async function sendMessage(token, chatId, text, parseMode) {
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const data = await resp.json().catch(() => ({}));
  return data.result || {};
}
async function editMessageText(token, chatId, messageId, text) {
  await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text })
  });
}
async function getFile(token, fileId) {
  const resp = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const data = await resp.json();
  if (!data.ok) throw new Error("Failed to fetch file info");
  return data.result;
}
async function sendDocumentWithThumbnail({ botToken, chatId, ipaPath, imagePath, filename }) {
  const ipaUrl = `https://api.telegram.org/file/bot${botToken}/${ipaPath}`;
  const ipaResp = await fetch(ipaUrl);
  if (!ipaResp.ok || !ipaResp.body) throw new Error("Failed to fetch IPA stream");

  let imgResp = null;
  if (imagePath) {
    const imgUrl = `https://api.telegram.org/file/bot${botToken}/${imagePath}`;
    imgResp = await fetch(imgUrl);
    if (!imgResp.ok || !imgResp.body) imgResp = null;
  }

  const boundary = "----RY7YYBoundary" + cryptoRandomId();
  const encoder = new TextEncoder();
  const partHeader = (name, filename, contentType) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${
      filename ? `; filename="${filename}"` : ""
    }\r\n${contentType ? `Content-Type: ${contentType}\r\n` : ""}\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;

  const bodyStream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(partHeader("chat_id") + chatId + "\r\n"));
      controller.enqueue(
        encoder.encode(partHeader("caption") + "📦 ملف داخل تيليجرام بالاسم الجديد والأيقونة\r\n")
      );
      controller.enqueue(
        encoder.encode(partHeader("document", sanitizeFilename(filename || "app.ipa"), "application/octet-stream"))
      );
      await pipeStream(ipaResp.body, controller); controller.enqueue(encoder.encode("\r\n"));
      if (imgResp && imgResp.body) {
        controller.enqueue(encoder.encode(partHeader("thumbnail", "thumb.jpg", "image/jpeg")));
        await pipeStream(imgResp.body, controller); controller.enqueue(encoder.encode("\r\n"));
      }
      controller.enqueue(encoder.encode(tail)); controller.close();
    }
  });

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: bodyStream
  });

  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`sendDocument failed: ${data.description || res.status}`);
}
async function sendDocumentByFileId({ botToken, chatId, fileId, caption }) {
  const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, document: fileId, caption: caption || "" })
  });
  const data = await resp.json().catch(() => ({}));
  if (!data.ok) throw new Error(`send by file_id failed: ${data.description || resp.status}`);
}
async function pipeStream(srcReadable, controller) {
  const reader = srcReadable.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    controller.enqueue(value);
  }
}