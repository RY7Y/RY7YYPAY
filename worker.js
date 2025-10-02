export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ========= الإعدادات العامة =========
    const BOT_TOKEN = env.BOT_TOKEN;
    const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : "";
    const CHANNEL_USERNAME = String(env.CHANNEL_USERNAME || "RY7DY").replace(/^@/, "");
    const OWNER_IDS = parseOwnerIds(env.OWNER_IDS); // مثال: "123,456"

    // حد إرسال multipart عبر Bot API (تقريبًا 50MB). الملف الكبير نرسله بالـ file_id والرابط فقط.
    const BOT_UPLOAD_LIMIT =
      Number(env.BOT_UPLOAD_LIMIT_BYTES || 48 * 1024 * 1024) || 48 * 1024 * 1024;

    // صحّة التوكن
    if (!BOT_TOKEN) {
      console.error("❌ Missing BOT_TOKEN env");
      return json({ error: "Missing BOT_TOKEN" }, 500);
    }

    // ========= فحص سريع للصحّة =========
    if (url.pathname === "/" || url.pathname === "") {
      return new Response("RY7YY Telegram Bot ✅ UP", { status: 200 });
    }

    // ========= تنزيل باسم مخصص عبر توكن مؤقت =========
    if (url.pathname.startsWith("/d/")) {
      try {
        const token = url.pathname.split("/d/")[1];
        if (!token) return new Response("Bad token", { status: 400 });

        const pack = await env.SESSION_KV.get(`dl:${token}`, { type: "json" });
        if (!pack) return new Response("Link expired", { status: 404 });

        const tgUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${pack.ipa_path}`;
        const tgResp = await fetch(tgUrl);
        if (!tgResp.ok) {
          console.error("❌ file proxy fetch failed:", tgResp.status, tgResp.statusText);
          return new Response("Source fetch failed", { status: 502 });
        }

        const headers = new Headers(tgResp.headers);
        headers.set(
          "Content-Disposition",
          `attachment; filename="${sanitizeFilename(pack.filename || "app.ipa")}"`
        );
        // نُعيد البودي كما هو بدون تخزين داخل ووركر
        return new Response(tgResp.body, { status: 200, headers });
      } catch (err) {
        console.error("❌ /d/ handler error:", err?.message || err);
        return new Response("Internal error", { status: 500 });
      }
    }

    // ========= Webhook تيليجرام =========
    if (url.pathname === "/telegram") {
      // تيليجرام يرسل POST فقط. تجاهل الباقي كي لا تُكتب أخطاء في اللوج
      if (request.method !== "POST") return new Response("OK", { status: 200 });

      let update = null;
      try {
        update = await request.json();
      } catch {
        console.error("❌ invalid JSON from Telegram");
        return json({ ok: false, error: "Invalid update" }, 400);
      }

      // اطبع التحديث في اللوج للمساعدة على التشخيص
      try {
        console.log("📩 Telegram Update:", JSON.stringify(update));
      } catch {}

      const msg = update.message || update.edited_message;
      if (!msg) return json({ ok: true });

      const chatId = msg.chat?.id;
      const userId = msg.from?.id;

      // ===== التحقق من الاشتراك (أو السماح من القائمة البيضاء) =====
      try {
        const allowed = await isAllowedUser({
          token: BOT_TOKEN,
          channelUserName: CHANNEL_USERNAME,
          userId,
          ownerIds: OWNER_IDS
        });

        if (!allowed) {
          await tgApi("sendMessage", {
            chat_id: chatId,
            text:
              `👋 لاستخدام البوت يرجى الاشتراك أولاً:\n` +
              `📣 https://t.me/${CHANNEL_USERNAME}\n\nثم أرسل /start.`,
            disable_web_page_preview: true
          });
          return json({ ok: true });
        }
      } catch (e) {
        console.error("❌ isAllowedUser error:", e?.message || e);
        // لو حصل خطأ شبكة أثناء فحص الاشتراك اسمح فقط لو في قائمة بيضاء
        if (!(OWNER_IDS && OWNER_IDS.has(Number(userId)))) {
          await tgApi("sendMessage", {
            chat_id: chatId,
            text:
              `تعذر التحقق من الاشتراك حاليًا.\n` +
              `جرّب لاحقًا أو اشترك بالقناة: https://t.me/${CHANNEL_USERNAME}`
          }).catch(() => {});
          return json({ ok: true });
        }
      }

      // ===== حالة/جلسة المستخدم =====
      let state =
        (await env.SESSION_KV.get(`state:${chatId}`, { type: "json" })) || {
          step: "awaiting_ipa", // awaiting_ipa -> awaiting_image -> awaiting_name
          ipa_file_id: null,
          ipa_path: null,
          ipa_size: 0,
          image_file_id: null,
          image_path: null,
          filename: null
        };

      // ===== أوامر مساعدة =====
      if (msg.text === "/ping") {
        await tgApi("sendMessage", { chat_id: chatId, text: "🏓 Pong – البوت يعمل ✅" });
        return json({ ok: true });
      }

      if (msg.text === "/reset") {
        await env.SESSION_KV.delete(`state:${chatId}`);
        await tgApi("sendMessage", {
          chat_id: chatId,
          text: "🔄 تم تصفير الجلسة. أرسل /start للبدء."
        });
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
        await tgApi("sendMessage", {
          chat_id: chatId,
          text:
            `👋 أهلاً بك في بوت RY7YY IPA!\n\n` +
            `📌 الخطوات:\n` +
            `1️⃣ أرسل ملف IPA (أي حجم).\n` +
            `2️⃣ أرسل صورة (Thumbnail) لعرضها كأيقونة داخل تيليجرام فقط.\n` +
            `3️⃣ أرسل اسم الملف المطلوب مثل: RY7YY.ipa\n\n` +
            `• إن كان الحجم مناسبًا سنعيد رفعه داخل تيليجرام **بالاسم الجديد ومع الأيقونة**.\n` +
            `• إن كان كبيرًا جدًا، سنرسل لك **رابط تنزيل بالاسم الجديد** ثم نعيد إرساله داخل تيليجرام بالـ file_id (قد يظهر بالاسم الأصلي بسبب حدود Bot API).`,
          disable_web_page_preview: true
        });
        return json({ ok: true });
      }

      // ===== استقبال IPA =====
      if (msg.document && state.step === "awaiting_ipa") {
        const doc = msg.document;
        if (!/\.ipa$/i.test(doc.file_name || "")) {
          await tgApi("sendMessage", {
            chat_id: chatId,
            text: "⚠️ رجاءً أرسل ملف بصيغة .ipa"
          });
          return json({ ok: true });
        }

        const info = await getFile(BOT_TOKEN, doc.file_id);
        state.ipa_file_id = doc.file_id;
        state.ipa_path = info.file_path;
        state.ipa_size = Number(doc.file_size || 0);
        state.step = "awaiting_image";
        await env.SESSION_KV.put(`state:${chatId}`, JSON.stringify(state));

        await tgApi("sendMessage", {
          chat_id: chatId,
          text: `✅ تم حفظ ملف IPA (${formatBytes(state.ipa_size)}).`
        });
        await tgApi("sendMessage", {
          chat_id: chatId,
          text: "📸 الآن أرسل صورة (ستظهر كأيقونة داخل تيليجرام فقط)."
        });
        return json({ ok: true });
      }

      // ===== استقبال الصورة =====
      if (msg.photo && state.step === "awaiting_image") {
        const best = msg.photo[msg.photo.length - 1];
        const info = await getFile(BOT_TOKEN, best.file_id);

        state.image_file_id = best.file_id;
        state.image_path = info.file_path;
        state.step = "awaiting_name";
        await env.SESSION_KV.put(`state:${chatId}`, JSON.stringify(state));

        await tgApi("sendMessage", { chat_id: chatId, text: "✅ تم حفظ الصورة." });
        await tgApi("sendMessage", {
          chat_id: chatId,
          text: "✍️ أرسل الآن اسم الملف مثل: `RY7YY.ipa`",
          parse_mode: "Markdown"
        });
        return json({ ok: true });
      }

      // ===== استقبال الاسم + عدّاد + الإرسال =====
      if (msg.text && state.step === "awaiting_name") {
        const desired = (msg.text || "").trim();
        if (!/\.ipa$/i.test(desired)) {
          await tgApi("sendMessage", {
            chat_id: chatId,
            text: "⚠️ الاسم غير صالح. يجب أن ينتهي بـ .ipa"
          });
          return json({ ok: true });
        }
        state.filename = desired;

        // أنشئ رابط تنزيل بالاسم الجديد (صالح 10 دقائق)
        const token = cryptoRandomId();
        await env.SESSION_KV.put(
          `dl:${token}`,
          JSON.stringify({ ipa_path: state.ipa_path, filename: state.filename }),
          { expirationTtl: 600 }
        );
        const renamedDownload = `${url.origin}/d/${token}`;

        // رسالة تجهيز + عدّاد تنازلي حقيقي (10 ثوان)
        const prep = await tgApi("sendMessage", {
          chat_id: chatId,
          text: `⏳ جاري التحضير...\n🔗 رابط التنزيل (اسم جديد): ${renamedDownload}`,
          disable_web_page_preview: true
        });

        for (let s = 10; s >= 0; s--) {
          await sleep(1000);
          await tgApi("editMessageText", {
            chat_id: chatId,
            message_id: prep.message_id,
            text: `⏳ التحضير: ${s} ثانية...\n🔗 ${renamedDownload}`,
            disable_web_page_preview: true
          }).catch(() => {});
        }

        try {
          if (state.ipa_size && state.ipa_size <= BOT_UPLOAD_LIMIT) {
            // صغير بما يكفي: نعيد الرفع مع thumbnail والاسم الجديد
            await sendDocumentWithThumbnail({
              botToken: BOT_TOKEN,
              chatId,
              ipaPath: state.ipa_path,
              imagePath: state.image_path,
              filename: state.filename
            });

            await tgApi("editMessageText", {
              chat_id: chatId,
              message_id: prep.message_id,
              text: `✅ تم الإرسال داخل تيليجرام بالاسم الجديد والأيقونة.\n🔗 أيضًا: ${renamedDownload}`,
              disable_web_page_preview: true
            });
          } else {
            // كبير: نرسل الرابط + نفس الملف بالـ file_id
            await tgApi("editMessageText", {
              chat_id: chatId,
              message_id: prep.message_id,
              text:
                `ℹ️ الملف كبير لإعادة الرفع باسم جديد عبر Bot API.\n` +
                `🔗 حمّل بالاسم الجديد: ${renamedDownload}\n` +
                `سيتم إرسال نفس الملف الآن داخل تيليجرام (قد يظهر بالاسم الأصلي).`,
              disable_web_page_preview: true
            });

            await sendDocumentByFileId({
              botToken: BOT_TOKEN,
              chatId,
              fileId: state.ipa_file_id,
              caption:
                "📦 نسخة داخل تيليجرام (قد يظهر الاسم الأصلي لقيود Bot API). استخدم الرابط أعلاه للاسم الجديد."
            });
          }
        } catch (e) {
          console.error("❌ send phase error:", e?.message || e);
          await tgApi("editMessageText", {
            chat_id: chatId,
            message_id: prep.message_id,
            text:
              `⚠️ تعذّر الإرسال داخل تيليجرام: ${e?.message || e}\n` +
              `🔗 تقدر تحمل بالاسم الجديد من هنا: ${renamedDownload}`,
            disable_web_page_preview: true
          }).catch(() => {});
        }

        // إنهاء الجلسة
        await env.SESSION_KV.delete(`state:${chatId}`);
        return json({ ok: true });
      }

      // رد افتراضي
      if (msg.text && !["/start", "/reset", "/ping"].includes(msg.text)) {
        await tgApi("sendMessage", {
          chat_id: chatId,
          text: "ℹ️ اكتب /start للبدء أو /reset لإعادة الضبط."
        }).catch(() => {});
      }

      return json({ ok: true });
    }

    return new Response("Not Found", { status: 404 });

    // ====== دوال داخلية (تحتاج الوصول لـ env/ctx؟ لا) ======
    async function tgApi(method, body) {
      // Helper موحّد مع طباعة أخطاء واضحة
      const res = await fetch(`${TELEGRAM_API}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }).catch((e) => {
        console.error(`❌ fetch(${method}) network error:`, e?.message || e);
        throw new Error("Network error calling Telegram");
      });

      let data = null;
      try {
        data = await res.json();
      } catch {
        console.error(`❌ fetch(${method}) invalid JSON`, res.status, res.statusText);
        throw new Error(`Telegram ${method} invalid JSON`);
      }

      if (!data.ok) {
        console.error(`❌ Telegram ${method} error:`, data.description || res.status);
        throw new Error(data.description || `Telegram ${method} failed`);
      }
      return data.result;
    }
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
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseOwnerIds(raw) {
  if (!raw) return new Set();
  return new Set(
    String(raw)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n))
  );
}

function formatBytes(n) {
  if (!n || n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

/** السماح لمن هم: creator/administrator/member في القناة، أو رقمهم ضمن OWNER_IDS */
async function isAllowedUser({ token, channelUserName, userId, ownerIds }) {
  try {
    if (ownerIds && ownerIds.has(Number(userId))) return true;
    const url = `https://api.telegram.org/bot${token}/getChatMember?chat_id=@${channelUserName}&user_id=${userId}`;
    const resp = await fetch(url);
    const data = await resp.json().catch(() => ({}));
    if (!data.ok) {
      // قناة خاصة/البوت ليس إدمن ⇒ نسمح فقط لقائمة المالكين
      return ownerIds && ownerIds.has(Number(userId));
    }
    const st = data.result?.status;
    return ["creator", "administrator", "member"].includes(st);
  } catch (e) {
    console.error("getChatMember error:", e?.message || e);
    return ownerIds && ownerIds.has(Number(userId));
  }
}

async function getFile(token, fileId) {
  const resp = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`).catch(
    (e) => {
      console.error("getFile network error:", e?.message || e);
      throw new Error("Network error (getFile)");
    }
  );
  const data = await resp.json().catch(() => {
    throw new Error("Invalid JSON (getFile)");
  });
  if (!data.ok) {
    throw new Error(`getFile failed: ${data.description || resp.status}`);
  }
  return data.result;
}

/** رفع IPA كـ multipart مع thumbnail (ينجح فقط إذا كان الحجم ≤ BOT_UPLOAD_LIMIT) */
async function sendDocumentWithThumbnail({ botToken, chatId, ipaPath, imagePath, filename }) {
  const ipaUrl = `https://api.telegram.org/file/bot${botToken}/${ipaPath}`;
  const ipaResp = await fetch(ipaUrl).catch((e) => {
    console.error("fetch IPA error:", e?.message || e);
    throw new Error("Failed to fetch IPA stream");
  });
  if (!ipaResp.ok || !ipaResp.body) throw new Error("Failed to fetch IPA stream");

  // الصورة اختيارية
  let imgResp = null;
  if (imagePath) {
    const imgUrl = `https://api.telegram.org/file/bot${botToken}/${imagePath}`;
    imgResp = await fetch(imgUrl).catch(() => null);
    if (imgResp && (!imgResp.ok || !imgResp.body)) imgResp = null;
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
        encoder.encode(partHeader("caption") + "📦 ملف داخل تيليجرام بالاسم الجديد والأيقونة (إن وجدت)\r\n")
      );

      // ملف IPA
      controller.enqueue(
        encoder.encode(
          partHeader("document", sanitizeFilename(filename || "app.ipa"), "application/octet-stream")
        )
      );
      await pipeStream(ipaResp.body, controller);
      controller.enqueue(encoder.encode("\r\n"));

      // الأيقونة (إن وجدت)
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
  }).catch((e) => {
    console.error("sendDocument network error:", e?.message || e);
    throw new Error("Network error (sendDocument)");
  });

  const data = await res.json().catch(() => {
    throw new Error("Invalid JSON (sendDocument)");
  });
  if (!data.ok) throw new Error(`sendDocument failed: ${data.description || res.status}`);
}

/** إرسال الملف نفسه بالـ file_id (يدعم أحجام ضخمة جدًا) */
async function sendDocumentByFileId({ botToken, chatId, fileId, caption }) {
  const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      document: fileId,
      caption: caption || ""
    })
  }).catch((e) => {
    console.error("send by file_id network error:", e?.message || e);
    throw new Error("Network error (sendDocument by file_id)");
  });

  const data = await resp.json().catch(() => {
    throw new Error("Invalid JSON (send by file_id)");
  });
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