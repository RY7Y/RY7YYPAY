export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method || "GET";

    /* ================== الإعدادات ================== */
    const BOT_TOKEN = env.BOT_TOKEN;                                     // إلزامي
    const CHANNEL_USERNAME = String(env.CHANNEL_USERNAME || "RY7DY").replace(/^@/, "");
    const OWNER_IDS = parseOwnerIds(env.OWNER_IDS);                      // "123,456"
    const BOT_UPLOAD_LIMIT = Number(env.BOT_UPLOAD_LIMIT_BYTES || 48 * 1024 * 1024);
    const DB = env.IPA_DB;                                               // D1 Database
    const KV = env.SESSION_KV;                                           // KV للجلسة فقط
    const UPLOAD_SECRET = env.UPLOAD_SECRET || "";                       // سري لمسارات الرفع من يوزربوت (اختياري)

    if (!BOT_TOKEN) return json({ error: "Missing BOT_TOKEN" }, 500);

    /* ========== تنزيل باسم مخصص من D1 ========== */
    if (url.pathname.startsWith("/d/")) {
      const token = url.pathname.slice(3);
      if (!token) return new Response("Bad token", { status: 400 });

      const pack = await KV.get(`dl:${token}`, { type: "json" });
      if (!pack) return new Response("Link expired", { status: 404 });

      if (pack.db_key) {
        const row = await DB.prepare(
          "SELECT data, filename FROM ipa_files WHERE key = ?"
        ).bind(pack.db_key).first();

        if (!row) return new Response("File not found", { status: 404 });

        const headers = new Headers();
        headers.set("Content-Type", "application/octet-stream");
        headers.set(
          "Content-Disposition",
          `attachment; filename="${sanitizeFilename(pack.filename || row.filename || "app.ipa")}"`
        );
        return new Response(row.data, { status: 200, headers });
      }
      return new Response("Source not available", { status: 410 });
    }

    /* ========== عرض صورة/أيقونة محفوظة في D1 ========== */
    if (url.pathname.startsWith("/thumb/")) {
      const key = url.pathname.slice(7);
      if (!key) return new Response("Not Found", { status: 404 });

      const row = await DB.prepare(
        "SELECT data, content_type FROM thumbs WHERE key = ?"
      ).bind(key).first();

      if (!row) return new Response("Thumbnail not found", { status: 404 });

      return new Response(row.data, {
        status: 200,
        headers: {
          "Content-Type": row.content_type || "image/jpeg",
          "Cache-Control": "public, max-age=86400"
        }
      });
    }

    /* ========== نقاط رفع اختيارية (للتكامل مع الـUserbot) ========== */
    if (url.pathname === "/upload" && method === "POST") {
      if (!UPLOAD_SECRET || request.headers.get("x-secret") !== UPLOAD_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const filename = request.headers.get("x-filename") || "app.ipa";
      const sizeHeader = request.headers.get("x-size");
      const size = sizeHeader ? Number(sizeHeader) : 0;

      const buf = await request.arrayBuffer();
      const key = "d1_" + cryptoRandomId();
      await DB.prepare(
        "INSERT INTO ipa_files (key, filename, size, data, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(key, filename, size || buf.byteLength, buf, new Date().toISOString()).run();

      return json({ ok: true, db_key: key });
    }

    if (url.pathname === "/upload-thumb" && method === "POST") {
      if (!UPLOAD_SECRET || request.headers.get("x-secret") !== UPLOAD_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const ctype = request.headers.get("content-type") || "image/jpeg";
      const buf = await request.arrayBuffer();
      const key = "th_" + cryptoRandomId();
      await DB.prepare(
        "INSERT INTO thumbs (key, content_type, data, created_at) VALUES (?, ?, ?, ?)"
      ).bind(key, ctype, buf, new Date().toISOString()).run();

      return json({ ok: true, thumb_key: key });
    }

    // نقطة لإكمال مهمة ضخمة من اليوزربوت (اختياري)
    if (url.pathname === "/complete" && method === "POST") {
      if (!UPLOAD_SECRET || request.headers.get("x-secret") !== UPLOAD_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const body = await request.json().catch(() => ({}));
      const { job_id, chat_id, filename, db_key } = body || {};
      if (!job_id || !chat_id || !filename || !db_key) {
        return json({ ok: false, error: "bad payload" }, 400);
      }

      // أنشئ رابط تنزيل
      const token = cryptoRandomId();
      await KV.put(`dl:${token}`, JSON.stringify({ db_key, filename }), { expirationTtl: 86400 });
      const dl = `${url.origin}/d/${token}`;

      await sendMessage(BOT_TOKEN, chat_id, `✅ تم تجهيز الملف!\n\n📝 الاسم: ${filename}\n🔗 ${dl}`);
      // احذف وصف المهمة لو كنت خزّنته في KV (اختياري)
      await KV.delete(`job:${job_id}`).catch(() => {});
      return json({ ok: true });
    }

    /* ================== Webhook تيليجرام ================== */
    if (url.pathname === "/telegram" && method === "POST") {
      const update = await request.json().catch(() => null);
      console.log("📩 Telegram Update:", JSON.stringify(update, null, 2));
      if (!update) return json({ ok: false, error: "Invalid update" }, 400);

      const msg = update.message || update.edited_message;
      if (!msg) return json({ ok: true });

      const chatId = msg.chat.id;
      const userId = msg.from?.id;

      // ✅ السماح (اشتراك القناة + وايت ليست)
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
      let state =
        (await KV.get(`state:${chatId}`, { type: "json" })) || {
          step: "awaiting_ipa",        // awaiting_ipa -> awaiting_image -> awaiting_name
          ipa_file_id: null,
          ipa_path: null,              // يتوفر للملفات الصغيرة فقط (≤ ~20MB)
          ipa_size: 0,
          db_key: null,                // مفتاح التخزين في D1
          image_file_id: null,
          image_path: null,            // قد يتوفر للصور
          thumb_db_key: null,          // مفتاح الصورة في D1
          filename: null
        };

      /* ================== أوامر عامة ================== */
      if (msg.text === "/reset") {
        await KV.delete(`state:${chatId}`);
        await sendMessage(BOT_TOKEN, chatId, "🔄 تم تصفير الجلسة. أرسل /start للبدء.");
        return json({ ok: true });
      }

      if (msg.text === "/start") {
        state = {
          step: "awaiting_ipa",
          ipa_file_id: null,
          ipa_path: null,
          ipa_size: 0,
          db_key: null,
          image_file_id: null,
          image_path: null,
          thumb_db_key: null,
          filename: null
        };
        await KV.put(`state:${chatId}`, JSON.stringify(state));

        await sendMessage(
          BOT_TOKEN,
          chatId,
          `👋 أهلاً بك في بوت RY7YY IPA!

📌 **الخطوات**:
1️⃣ أرسل **ملف IPA** (أي حجم — الصغيرة يرسلها تيليجرام مباشرة، والكبيرة نجهز لك رابط).
2️⃣ أرسل **صورة/Thumbnail** (كأيقونة للملف داخل تيليجرام للملفات الصغيرة، وتبقى كرابط للكبيرة).
3️⃣ أرسل **اسم الملف المطلوب** (مثل: \`RY7YY.ipa\`).

✅ إن كان الملف صغيرًا (≤ ${formatBytes(BOT_UPLOAD_LIMIT)}):
- نعيد رفعه داخل تيليجرام **بالاسم الجديد مع الأيقونة** + نعطيك **رابط تحميل** من التخزين.

⚠️ إن كان الملف كبيرًا جدًا:
- لن نستخدم \`file_id\` إطلاقًا.
- نُخزّنه في **D1** ونرسل لك **رابط التحميل باسمك الجديد**.
`, "Markdown"
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

        // نحاول تنزيله فقط لو صغير (Telegram getFile محدود ~20MB)
        const status = await sendMessage(
          BOT_TOKEN,
          chatId,
          `⏳ جاري معالجة الملف: ${formatBytes(state.ipa_size)}...`
        );

        if (state.ipa_size <= 20 * 1024 * 1024) {
          try {
            const fileInfo = await getFile(BOT_TOKEN, doc.file_id);   // يوفّر file_path
            const tgUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
            const tgResp = await fetch(tgUrl);
            if (!tgResp.ok) throw new Error("Failed to download IPA");

            // خزّن في D1
            const buf = await tgResp.arrayBuffer();
            const dbKey = "d1_" + cryptoRandomId();
            await DB.prepare(
              "INSERT INTO ipa_files (key, filename, size, data, created_at) VALUES (?, ?, ?, ?, ?)"
            ).bind(dbKey, doc.file_name || "app.ipa", state.ipa_size, buf, new Date().toISOString()).run();

            // احفظ الحالة
            state.db_key = dbKey;
            state.ipa_path = fileInfo.file_path;   // لاستخدامه في إعادة الرفع داخل تيليجرام لاحقًا
            state.step = "awaiting_image";
            await KV.put(`state:${chatId}`, JSON.stringify(state));

            await editMessageText(BOT_TOKEN, chatId, status.message_id, "✅ تم حفظ ملف IPA.");
            await sendMessage(BOT_TOKEN, chatId, "📸 الآن أرسل صورة (ستظهر كأيقونة داخل تيليجرام للملفات الصغيرة).");
            return json({ ok: true });
          } catch (e) {
            console.log("getFile/small download failed:", e?.message);
            // حتى لو فشل التنزيل الصغير—نسمح بالإكمال كرابط لاحق (بدون إرسال داخل تيليجرام)
            state.db_key = null;
            state.ipa_path = null;
            state.step = "awaiting_image";
            await KV.put(`state:${chatId}`, JSON.stringify(state));
            await editMessageText(BOT_TOKEN, chatId, status.message_id, "ℹ️ سنجهّز الملف كرابط فقط.");
            await sendMessage(BOT_TOKEN, chatId, "📸 الآن أرسل صورة (اختياري).");
            return json({ ok: true });
          }
        } else {
          // كبير: لا نحاول getFile — لن نستخدم file_id إطلاقًا للإرسال
          state.db_key = null;   // نحتاج رفع خارجي (يوزربوت ✔) أو تفعيل /upload يدوي
          state.ipa_path = null;
          state.step = "awaiting_image";
          await KV.put(`state:${chatId}`, JSON.stringify(state));

          await editMessageText(
            BOT_TOKEN,
            chatId,
            status.message_id,
            `📦 ملف كبير (${formatBytes(state.ipa_size)}).\nسنجهّزه كرابط تحميل باسمك الجديد.`
          );
          await sendMessage(BOT_TOKEN, chatId, "📸 الآن أرسل صورة (اختياري).");
          return json({ ok: true });
        }
      }

      /* ================== استقبال صورة ================== */
      if (msg.photo && state.step === "awaiting_image") {
        const best = msg.photo[msg.photo.length - 1];
        state.image_file_id = best.file_id;

        // سنحاول حفظها في D1 أيضًا كرابط thumb عام
        try {
          const info = await getFile(BOT_TOKEN, best.file_id);
          if (info?.file_path) {
            const imgUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${info.file_path}`;
            const imgResp = await fetch(imgUrl);
            if (imgResp.ok) {
              const buf = await imgResp.arrayBuffer();
              const key = "th_" + cryptoRandomId();
              await DB.prepare(
                "INSERT INTO thumbs (key, content_type, data, created_at) VALUES (?, ?, ?, ?)"
              ).bind(key, "image/jpeg", buf, new Date().toISOString()).run();
              state.thumb_db_key = key;
            }
            state.image_path = info.file_path;
          }
        } catch {
          // الصورة اختيارية — نتجاهل أي فشل
        }

        state.step = "awaiting_name";
        await KV.put(`state:${chatId}`, JSON.stringify(state));

        await sendMessage(BOT_TOKEN, chatId, "✅ تم حفظ الصورة.");
        await sendMessage(BOT_TOKEN, chatId, "✍️ أرسل الآن اسم الملف مثل: `RY7YY.ipa`", "Markdown");
        return json({ ok: true });
      }

      /* ================== استقبال الاسم + العدّاد + الإرسال/الرابط ================== */
      if (msg.text && state.step === "awaiting_name") {
        const desired = (msg.text || "").trim();
        if (!/\.ipa$/i.test(desired)) {
          await sendMessage(BOT_TOKEN, chatId, "⚠️ الاسم غير صالح. يجب أن ينتهي بـ .ipa");
          return json({ ok: true });
        }
        state.filename = desired;

        // جهّز رابط تنزيل من D1 إن كان لدينا db_key
        let downloadLink = null;
        if (state.db_key) {
          const token = cryptoRandomId();
          await KV.put(
            `dl:${token}`,
            JSON.stringify({ db_key: state.db_key, filename: state.filename }),
            { expirationTtl: 86400 }
          );
          downloadLink = `${url.origin}/d/${token}`;
        }

        const prep = await sendMessage(
          BOT_TOKEN,
          chatId,
          `⏳ جاري التحضير...${downloadLink ? `\n🔗 ${downloadLink}` : ""}`
        );

        // عدّاد بسيط
        for (let s = 10; s >= 0; s--) {
          await sleep(1000);
          await editMessageText(
            BOT_TOKEN,
            chatId,
            prep.message_id,
            `⏳ التحضير: ${s} ثانية...${downloadLink ? `\n🔗 ${downloadLink}` : ""}`
          ).catch(() => {});
        }

        try {
          // إن كان صغيرًا ولدينا ipa_path + ضمن حد الرفع المتعدد ⇒ أرسل داخل تيليجرام بالاسم الجديد والأيقونة
          if (state.ipa_path && state.ipa_size <= BOT_UPLOAD_LIMIT) {
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
              `✅ تم الإرسال داخل تيليجرام بالاسم الجديد والأيقونة.${
                downloadLink ? `\n🔗 رابط التنزيل أيضًا: ${downloadLink}` : ""
              }${state.thumb_db_key ? `\n🖼️ الأيقونة: ${url.origin}/thumb/${state.thumb_db_key}` : ""}`
            );
          } else {
            // كبير أو بدون ipa_path ⇒ لا نستخدم file_id إطلاقًا. نكتفي بالرابط من D1 إن وُجد.
            if (state.db_key && downloadLink) {
              await editMessageText(
                BOT_TOKEN,
                chatId,
                prep.message_id,
                `✅ تم التجهيز!\n📝 الاسم: ${state.filename}\n📦 الحجم: ${formatBytes(state.ipa_size)}\n🔗 ${downloadLink}${
                  state.thumb_db_key ? `\n🖼️ الأيقونة: ${url.origin}/thumb/${state.thumb_db_key}` : ""
                }`
              );
            } else {
              // لا نملك المحتوى (ملف كبير ولم يُرفع خارجيًا) — نوضح له
              await editMessageText(
                BOT_TOKEN,
                chatId,
                prep.message_id,
                `⚠️ الملف كبير ولا يمكن تنزيله عبر Bot API.\n\n` +
                  `• إن كنت فعّلت تكامل اليوزربوت، اجعله يرفع الملف إلى ${url.origin}/upload مع \`x-secret\`.\n` +
                  `• بعدها يمكنك إعادة إرسال الاسم ليُنشأ الرابط.`
              );
            }
          }
        } catch (e) {
          await editMessageText(
            BOT_TOKEN,
            chatId,
            prep.message_id,
            `⚠️ تعذّر الإكمال: ${e.message || "unknown"}${
              downloadLink ? `\nما يزال بإمكانك التحميل: ${downloadLink}` : ""
            }`
          );
        }

        // نهاية الجلسة
        await KV.delete(`state:${chatId}`);
        return json({ ok: true });
      }

      // ====== رد افتراضي ======
      if (msg.text && !["/start", "/reset"].includes(msg.text)) {
        await sendMessage(BOT_TOKEN, chatId, "ℹ️ اكتب /start للبدء أو /reset لإعادة الضبط.");
      }
      return json({ ok: true });
    }

    // صفحة فحص
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "RY7YY Telegram Bot ✅\n• جلسات عبر KV فقط\n• تخزين ملفات عبر D1\n• بدون file_id للكبيرة\n",
        { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
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
      // قناة خاصة/البوت ليس إدمن ⇒ نسمح فقط لمن هم بالقائمة البيضاء
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

async function getFile(token, fileId) {
  const resp = await fetch(
    `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`
  );
  const data = await resp.json();
  if (!data.ok) throw new Error("Failed to fetch file info");
  return data.result;
}

/** رفع IPA كـ multipart داخل تيليجرام مع thumbnail واسم جديد (للملفات الصغيرة فقط) */
async function sendDocumentWithThumbnail({ botToken, chatId, ipaPath, imagePath, filename }) {
  const ipaUrl = `https://api.telegram.org/file/bot${botToken}/${ipaPath}`;
  const ipaResp = await fetch(ipaUrl);
  if (!ipaResp.ok || !ipaResp.body) throw new Error("Failed to fetch IPA stream");

  // الصورة اختيارية — إن توفّر stream للصورة سنرفقها كـ thumbnail
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
        encoder.encode(
          partHeader("caption") + "📦 ملف داخل تيليجرام بالاسم الجديد والأيقونة\r\n"
        )
      );
      // ملف IPA
      controller.enqueue(
        encoder.encode(
          partHeader("document", sanitizeFilename(filename || "app.ipa"), "application/octet-stream")
        )
      );
      await pipeStream(ipaResp.body, controller);
      controller.enqueue(encoder.encode("\r\n"));

      // الأيقونة كـ thumbnail (اختياري)
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

async function pipeStream(srcReadable, controller) {
  const reader = srcReadable.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    controller.enqueue(value);
  }
}