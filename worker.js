export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /* ================== الإعدادات ================== */
    const BOT_TOKEN = env.BOT_TOKEN;
    const CHANNEL_USERNAME = String(env.CHANNEL_USERNAME || "RY7DY").replace(/^@/, "");
    const OWNER_IDS = parseOwnerIds(env.OWNER_IDS);
    const BOT_UPLOAD_LIMIT = Number(env.BOT_UPLOAD_LIMIT_BYTES || 48 * 1024 * 1024);
    const R2_BUCKET = env.IPA_BUCKET;

    if (!BOT_TOKEN) return json({ error: "Missing BOT_TOKEN" }, 500);

    /* ========== تنزيل باسم مخصص من R2 أو Telegram ========== */
    if (url.pathname.startsWith("/d/")) {
      const token = url.pathname.split("/d/")[1];
      if (!token) return new Response("Bad token", { status: 400 });

      const pack = await env.SESSION_KV.get(`dl:${token}`, { type: "json" });
      if (!pack) return new Response("Link expired", { status: 404 });

      if (pack.r2_key) {
        if (!R2_BUCKET) return new Response("R2 not configured", { status: 500 });
        
        const obj = await R2_BUCKET.get(pack.r2_key);
        if (!obj) return new Response("File not found in storage", { status: 404 });

        const headers = new Headers();
        headers.set("Content-Type", "application/octet-stream");
        headers.set("Content-Disposition", `attachment; filename="${sanitizeFilename(pack.filename || "app.ipa")}"`);
        headers.set("Content-Length", obj.size.toString());
        
        return new Response(obj.body, { status: 200, headers });
      }

      if (pack.ipa_path) {
        const tgUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${pack.ipa_path}`;
        const tgResp = await fetch(tgUrl);
        if (!tgResp.ok) return new Response("Source fetch failed", { status: 502 });

        const headers = new Headers(tgResp.headers);
        headers.set("Content-Disposition", `attachment; filename="${sanitizeFilename(pack.filename || "app.ipa")}"`);
        return new Response(tgResp.body, { status: 200, headers });
      }

      return new Response("Source not available", { status: 410 });
    }

    /* ========== عرض الصورة/الأيقونة من R2 ========== */
    if (url.pathname.startsWith("/thumb/")) {
      const token = url.pathname.split("/thumb/")[1];
      if (!token || !R2_BUCKET) return new Response("Not Found", { status: 404 });

      const obj = await R2_BUCKET.get(`thumb_${token}`);
      if (!obj) return new Response("Thumbnail not found", { status: 404 });

      return new Response(obj.body, {
        status: 200,
        headers: {
          "Content-Type": obj.httpMetadata?.contentType || "image/jpeg",
          "Cache-Control": "public, max-age=86400"
        }
      });
    }

    /* ================== Webhook تيليجرام ================== */
    if (url.pathname === "/telegram" && request.method === "POST") {
      const update = await request.json().catch(() => null);
      console.log("📩 Telegram Update:", JSON.stringify(update, null, 2));

      if (!update) return json({ ok: false, error: "Invalid update" }, 400);

      const msg = update.message || update.edited_message;
      if (!msg) return json({ ok: true });

      const chatId = msg.chat.id;
      const userId = msg.from?.id;

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

      /* ================== حالة/جلسة المستخدم ================== */
      let state = (await env.SESSION_KV.get(`state:${chatId}`, { type: "json" })) || {
        step: "awaiting_ipa",
        ipa_file_id: null,
        ipa_path: null,
        ipa_size: 0,
        r2_key: null,
        image_file_id: null,
        image_path: null,
        r2_thumb_key: null,
        filename: null
      };

      /* ================== أوامر عامة ================== */
      if (msg.text === "/reset") {
        if (state.r2_key && R2_BUCKET) {
          await R2_BUCKET.delete(state.r2_key).catch(() => {});
        }
        if (state.r2_thumb_key && R2_BUCKET) {
          await R2_BUCKET.delete(state.r2_thumb_key).catch(() => {});
        }
        await env.SESSION_KV.delete(`state:${chatId}`);
        await sendMessage(BOT_TOKEN, chatId, "🔄 تم تصفير الجلسة وحذف الملفات المؤقتة. أرسل /start للبدء.");
        return json({ ok: true });
      }

      if (msg.text === "/start") {
        if (state.r2_key && R2_BUCKET) {
          await R2_BUCKET.delete(state.r2_key).catch(() => {});
        }
        if (state.r2_thumb_key && R2_BUCKET) {
          await R2_BUCKET.delete(state.r2_thumb_key).catch(() => {});
        }

        state = {
          step: "awaiting_ipa",
          ipa_file_id: null,
          ipa_path: null,
          ipa_size: 0,
          r2_key: null,
          image_file_id: null,
          image_path: null,
          r2_thumb_key: null,
          filename: null
        };
        await env.SESSION_KV.put(`state:${chatId}`, JSON.stringify(state));
        await sendMessage(
          BOT_TOKEN,
          chatId,
          `👋 أهلاً بك في بوت RY7YY IPA المطوّر!

📌 الخطوات:
1️⃣ أرسل ملف IPA (أي حجم - حتى 50GB+).
2️⃣ أرسل صورة/Thumbnail (ستظهر كأيقونة).
3️⃣ أرسل اسم الملف المطلوب (مثل: RY7YY.ipa).

✨ المميزات:
• الملفات الصغيرة (<50MB): إعادة رفع مباشرة في تيليجرام
• الملفات الكبيرة (>50MB): رفع تلقائي إلى التخزين السحابي
• دعم ملفات عملاقة حتى 50GB+
• تغيير الاسم والأيقونة بشكل احترافي
• روابط تنزيل سريعة ومخصصة`
        );
        return json({ ok: true });
      }

      /* ================== استقبال IPA ================== */
      if (msg.document && state.step === "awaiting_ipa") {
        const doc = msg.document;
        if (!/\.ipa$/i.test(doc.file_name || "")) {
          await sendMessage(BOT_TOKEN, chatId, "⚠️ رجاءً أرسل ملف بصيغة .ipa");
          return json({ ok: true });
        }

        state.ipa_file_id = doc.file_id;
        state.ipa_size = Number(doc.file_size || 0);

        const statusMsg = await sendMessage(
          BOT_TOKEN,
          chatId,
          `⏳ جاري معالجة الملف (${formatBytes(state.ipa_size)})...`
        );

        if (state.ipa_size > BOT_UPLOAD_LIMIT) {
          if (!R2_BUCKET) {
            await editMessageText(
              BOT_TOKEN,
              chatId,
              statusMsg.message_id,
              `⚠️ الملف كبير جداً (${formatBytes(state.ipa_size)}) ولم يتم تكوين التخزين السحابي.\n\nسأحفظ معلومات الملف فقط.`
            );
            state.ipa_path = null;
            state.r2_key = null;
            state.step = "awaiting_image";
            await env.SESSION_KV.put(`state:${chatId}`, JSON.stringify(state));
            await sendMessage(BOT_TOKEN, chatId, "📸 الآن أرسل صورة (ستظهر كأيقونة).");
            return json({ ok: true });
          }

          try {
            await editMessageText(
              BOT_TOKEN,
              chatId,
              statusMsg.message_id,
              `📤 رفع الملف إلى التخزين السحابي...\n📦 الحجم: ${formatBytes(state.ipa_size)}\n⏳ انتظر من فضلك...`
            );

            const fileInfo = await getFile(BOT_TOKEN, doc.file_id);
            const tgUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
            const tgResp = await fetch(tgUrl);
            
            if (!tgResp.ok || !tgResp.body) {
              throw new Error("Failed to download from Telegram");
            }

            const r2Key = `ipa_${chatId}_${Date.now()}_${cryptoRandomId()}`;
            
            await R2_BUCKET.put(r2Key, tgResp.body, {
              httpMetadata: {
                contentType: "application/octet-stream"
              },
              customMetadata: {
                originalName: doc.file_name || "app.ipa",
                uploadedBy: String(userId),
                uploadedAt: new Date().toISOString()
              }
            });

            state.r2_key = r2Key;
            state.ipa_path = null;
            state.step = "awaiting_image";
            await env.SESSION_KV.put(`state:${chatId}`, JSON.stringify(state));

            await editMessageText(
              BOT_TOKEN,
              chatId,
              statusMsg.message_id,
              `✅ تم رفع الملف بنجاح إلى التخزين السحابي!\n📦 الحجم: ${formatBytes(state.ipa_size)}\n🔐 محفوظ بشكل آمن`
            );
            await sendMessage(BOT_TOKEN, chatId, "📸 الآن أرسل صورة (ستظهر كأيقونة للملف).");
            return json({ ok: true });

          } catch (e) {
            console.error("R2 upload failed:", e);
            await editMessageText(
              BOT_TOKEN,
              chatId,
              statusMsg.message_id,
              `⚠️ فشل رفع الملف إلى التخزين: ${e.message}\n\nسأحفظ معلومات الملف للإرسال المباشر.`
            );
            state.r2_key = null;
            state.ipa_path = null;
            state.step = "awaiting_image";
            await env.SESSION_KV.put(`state:${chatId}`, JSON.stringify(state));
            await sendMessage(BOT_TOKEN, chatId, "📸 الآن أرسل صورة (ستظهر كأيقونة).");
            return json({ ok: true });
          }
        } else {
          try {
            const fileInfo = await getFile(BOT_TOKEN, doc.file_id);
            state.ipa_path = fileInfo.file_path;
            state.r2_key = null;
            state.step = "awaiting_image";
            await env.SESSION_KV.put(`state:${chatId}`, JSON.stringify(state));

            await editMessageText(
              BOT_TOKEN,
              chatId,
              statusMsg.message_id,
              `✅ تم حفظ ملف IPA (${formatBytes(state.ipa_size)}).`
            );
            await sendMessage(BOT_TOKEN, chatId, "📸 الآن أرسل صورة (ستظهر كأيقونة في رسالة تيليجرام).");
            return json({ ok: true });
          } catch (e) {
            console.log("getFile failed for small IPA:", e?.message);
            state.ipa_path = null;
            state.r2_key = null;
            state.step = "awaiting_image";
            await env.SESSION_KV.put(`state:${chatId}`, JSON.stringify(state));
            await editMessageText(
              BOT_TOKEN,
              chatId,
              statusMsg.message_id,
              `⚠️ تم حفظ الملف (${formatBytes(state.ipa_size)}) لكن لا يمكن تنزيله.`
            );
            await sendMessage(BOT_TOKEN, chatId, "📸 الآن أرسل صورة (ستظهر كأيقونة).");
            return json({ ok: true });
          }
        }
      }

      /* ================== استقبال صورة ================== */
      if (msg.photo && state.step === "awaiting_image") {
        const bestPhoto = msg.photo[msg.photo.length - 1];
        
        const statusMsg = await sendMessage(BOT_TOKEN, chatId, "⏳ جاري معالجة الصورة...");

        try {
          const photoInfo = await getFile(BOT_TOKEN, bestPhoto.file_id);
          state.image_file_id = bestPhoto.file_id;
          state.image_path = photoInfo?.file_path || null;

          if (R2_BUCKET && photoInfo?.file_path) {
            try {
              const imgUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${photoInfo.file_path}`;
              const imgResp = await fetch(imgUrl);
              
              if (imgResp.ok && imgResp.body) {
                const thumbKey = `thumb_${cryptoRandomId()}`;
                await R2_BUCKET.put(thumbKey, imgResp.body, {
                  httpMetadata: {
                    contentType: "image/jpeg"
                  }
                });
                state.r2_thumb_key = thumbKey;
              }
            } catch (e) {
              console.log("Failed to upload thumbnail to R2:", e?.message);
            }
          }

          state.step = "awaiting_name";
          await env.SESSION_KV.put(`state:${chatId}`, JSON.stringify(state));

          await editMessageText(BOT_TOKEN, chatId, statusMsg.message_id, "✅ تم حفظ الصورة بنجاح.");
          await sendMessage(BOT_TOKEN, chatId, "✍️ الآن أرسل اسم الملف المطلوب (مثل: RY7YY.ipa)", "Markdown");
          return json({ ok: true });
        } catch (e) {
          console.error("Image processing failed:", e);
          state.image_file_id = bestPhoto.file_id;
          state.image_path = null;
          state.r2_thumb_key = null;
          state.step = "awaiting_name";
          await env.SESSION_KV.put(`state:${chatId}`, JSON.stringify(state));

          await editMessageText(BOT_TOKEN, chatId, statusMsg.message_id, "⚠️ حفظ الصورة (قد لا تظهر).");
          await sendMessage(BOT_TOKEN, chatId, "✍️ الآن أرسل اسم الملف المطلوب (مثل: RY7YY.ipa)", "Markdown");
          return json({ ok: true });
        }
      }

      /* ================== استقبال الاسم + الإرسال ================== */
      if (msg.text && state.step === "awaiting_name") {
        const desired = (msg.text || "").trim();
        if (!/\.ipa$/i.test(desired)) {
          await sendMessage(BOT_TOKEN, chatId, "⚠️ الاسم غير صالح. يجب أن ينتهي بـ .ipa");
          return json({ ok: true });
        }
        state.filename = desired;

        let downloadLink = null;
        if (state.r2_key || state.ipa_path) {
          const token = cryptoRandomId();
          await env.SESSION_KV.put(
            `dl:${token}`,
            JSON.stringify({
              r2_key: state.r2_key,
              ipa_path: state.ipa_path,
              filename: state.filename
            }),
            { expirationTtl: 86400 }
          );
          downloadLink = `${url.origin}/d/${token}`;
        }

        const thumbLink = state.r2_thumb_key ? `${url.origin}/thumb/${state.r2_thumb_key}` : null;

        const prep = await sendMessage(
          BOT_TOKEN,
          chatId,
          `⏳ جاري التحضير النهائي...`
        );

        await sendChatAction(BOT_TOKEN, chatId, "upload_document").catch(() => {});
        
        for (let s = 5; s >= 0; s--) {
          await sleep(1000);
          await editMessageText(
            BOT_TOKEN,
            chatId,
            prep.message_id,
            `⏳ التحضير: ${s} ثانية...`
          ).catch(() => {});
        }

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
              `✅ تم الإرسال داخل تيليجرام بالاسم والأيقونة الجديدة!${
                downloadLink ? `\n\n🔗 رابط التنزيل المباشر:\n${downloadLink}` : ""
              }${thumbLink ? `\n\n🖼️ الأيقونة:\n${thumbLink}` : ""}`
            );
          } else if (state.ipa_file_id) {
            const withThumbOk = await sendDocumentByFileId({
              botToken: BOT_TOKEN,
              chatId,
              fileId: state.ipa_file_id,
              thumbFileId: state.image_file_id,
              caption: "📦 الملف داخل تيليجرام"
            }).catch(async (e) => {
              console.log("send by file_id with thumbnail failed; retry without:", e?.message);
              await sendDocumentByFileId({
                botToken: BOT_TOKEN,
                chatId,
                fileId: state.ipa_file_id,
                thumbFileId: null,
                caption: "📦 الملف داخل تيليجرام"
              });
              return false;
            });

            await editMessageText(
              BOT_TOKEN,
              chatId,
              prep.message_id,
              `✅ تم إرسال الملف!${
                downloadLink
                  ? `\n\n🔗 رابط التنزيل بالاسم الجديد:\n${downloadLink}\n\n📝 الاسم: ${state.filename}\n📦 الحجم: ${formatBytes(state.ipa_size)}`
                  : ""
              }${thumbLink ? `\n\n🖼️ الأيقونة:\n${thumbLink}` : ""}`
            );
          } else if (downloadLink) {
            await editMessageText(
              BOT_TOKEN,
              chatId,
              prep.message_id,
              `✅ تم التجهيز!\n\n🔗 رابط التنزيل:\n${downloadLink}\n\n📝 الاسم: ${state.filename}\n📦 الحجم: ${formatBytes(state.ipa_size)}${
                thumbLink ? `\n\n🖼️ الأيقونة:\n${thumbLink}` : ""
              }`
            );
          } else {
            await editMessageText(
              BOT_TOKEN,
              chatId,
              prep.message_id,
              `⚠️ لا يمكن إرسال الملف بالطريقة المطلوبة. حجم الملف: ${formatBytes(state.ipa_size)}`
            );
          }
        } catch (e) {
          console.error("Send failed:", e);
          await editMessageText(
            BOT_TOKEN,
            chatId,
            prep.message_id,
            `⚠️ حدث خطأ: ${e.message}${
              downloadLink ? `\n\nيمكنك التحميل من:\n${downloadLink}` : ""
            }`
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
      return new Response("🤖 RY7YY Telegram IPA Bot ✅\n\n✨ دعم ملفات حتى 50GB+\n🚀 Powered by Cloudflare R2", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
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
  return name.replace(/[^a-zA-Z0-9._\u0600-\u06FF-]+/g, "_");
}

function cryptoRandomId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function parseOwnerIds(raw) {
  if (!raw) return new Set();
  return new Set(
    String(raw)
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => Number(s))
      .filter(n => Number.isFinite(n))
  );
}

function formatBytes(n) {
  if (!n || n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
}

async function sleep(ms) {
  await new Promise(r => setTimeout(r, ms));
}

async function isAllowedUser({ token, channelUserName, userId, ownerIds }) {
  try {
    if (ownerIds && ownerIds.has(Number(userId))) return true;
    const url = `https://api.telegram.org/bot${token}/getChatMember?chat_id=@${channelUserName}&user_id=${userId}`;
    const resp = await fetch(url);
    const data = await resp.json().catch(() => ({}));
    if (!data.ok) {
      return ownerIds && ownerIds.has(Number(userId));
    }
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

async function sendChatAction(token, chatId, action) {
  await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: action || "typing" })
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
        encoder.encode(partHeader("caption") + "📦 ملف IPA بالاسم والأيقونة الجديدة\r\n")
      );

      controller.enqueue(
        encoder.encode(
          partHeader("document", sanitizeFilename(filename || "app.ipa"), "application/octet-stream")
        )
      );
      await pipeStream(ipaResp.body, controller);
      controller.enqueue(encoder.encode("\r\n"));

      if (imgResp && imgResp.body) {
        controller.enqueue(encoder.encode(partHeader("thumbnail", "thumb.jpg", "image/jpeg")));
        await pipeStream(imgResp.body, controller);
        controller.enqueue(encoder.encode("\r\n"));
      }

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

async function sendDocumentByFileId({ botToken, chatId, fileId, thumbFileId, caption }) {
  const body = {
    chat_id: chatId,
    document: fileId,
    caption: caption || ""
  };
  if (thumbFileId) body.thumbnail = thumbFileId;

  let resp = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  let data = await resp.json().catch(() => ({}));
  
  if (!data.ok && thumbFileId) {
    const resp2 = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, document: fileId, caption: caption || "" })
    });
    data = await resp2.json().catch(() => ({}));
  }
  
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