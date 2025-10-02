export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method || "GET";

    /* ================== الإعدادات ================== */
    const BOT_TOKEN = env.BOT_TOKEN;                                      // إلزامي
    const CHANNEL_USERNAME = String(env.CHANNEL_USERNAME || "RY7DY").replace(/^@/, "");
    const OWNER_IDS = parseOwnerIds(env.OWNER_IDS);                       // "123,456"
    const BOT_UPLOAD_LIMIT = Number(env.BOT_UPLOAD_LIMIT_BYTES || 50 * 1024 * 1024); // حد رفع تيليجرام للبوت
    const DB = env.IPA_DB;                                                // D1 Database
    const KV = env.SESSION_KV;                                            // KV للجلسات والروابط

    if (!BOT_TOKEN) return json({ error: "Missing BOT_TOKEN" }, 500);

    // تأكيد/ترقية المخطط إن لزم (يعمل مرة واحدة غالبًا)
    await ensureSchema(DB).catch(() => {});

    /* ========== تنزيل من D1 ========== */
    if (url.pathname.startsWith("/d/")) {
      const token = url.pathname.slice(3);
      if (!token) return new Response("Bad token", { status: 400 });

      const pack = await KV.get(`dl:${token}`, { type: "json" });
      if (!pack) return new Response("Link expired", { status: 404 });

      const row = await DB.prepare(
        "SELECT data, filename FROM ipa_files WHERE id = ?"
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

    /* ========== عرض صورة محفوظة من D1 ========== */
    if (url.pathname.startsWith("/thumb/")) {
      const key = url.pathname.slice(7);
      const row = await DB.prepare(
        "SELECT data, content_type FROM ipa_thumbs WHERE id = ?"
      ).bind(key).first();

      if (!row) return new Response("Thumbnail not found", { status: 404 });

      return new Response(row.data, {
        status: 200,
        headers: { "Content-Type": row.content_type || "image/jpeg", "Cache-Control": "public, max-age=86400" }
      });
    }

    /* ========== صفحة رفع للملفات الكبيرة (بدون Userbot) ========== */
    if (url.pathname.startsWith("/u/")) {
      const token = url.pathname.slice(3);
      const ticket = await KV.get(`upl:${token}`, { type: "json" }); // { chat_id }
      if (!ticket) return new Response("Upload ticket expired", { status: 410 });

      if (method === "GET") {
        return new Response(renderUploadHTML(token), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      }

      if (method === "POST") {
        const form = await request.formData().catch(() => null);
        if (!form) return new Response("Bad form", { status: 400 });
        const ipaFile = form.get("ipa");
        if (!ipaFile || !ipaFile.arrayBuffer) return new Response("IPA required", { status: 400 });

        const desiredName = String(form.get("filename") || "app.ipa").trim();
        const finalName = /\.ipa$/i.test(desiredName) ? desiredName : `${desiredName}.ipa`;

        const ipaBuf = await ipaFile.arrayBuffer();
        const dbKey = "ipa_" + cryptoRandomId();
        await DB.prepare(
          "INSERT INTO ipa_files (id, filename, size, data, uploaded_at) VALUES (?, ?, ?, ?, ?)"
        ).bind(dbKey, finalName, ipaBuf.byteLength, ipaBuf, Date.now()).run();

        // الصورة اختيارية
        const thumbFile = form.get("thumb");
        let thumbKey = null;
        if (thumbFile && thumbFile.arrayBuffer) {
          const tb = await thumbFile.arrayBuffer();
          thumbKey = "th_" + cryptoRandomId();
          await DB.prepare(
            "INSERT INTO ipa_thumbs (id, ipa_id, data, content_type, created_at) VALUES (?, ?, ?, ?, ?)"
          ).bind(thumbKey, dbKey, tb, thumbFile.type || "image/jpeg", Date.now()).run();
        }

        // أنشئ رابط تنزيل
        const dlTok = cryptoRandomId();
        await KV.put(`dl:${dlTok}`, JSON.stringify({ db_key: dbKey, filename: finalName }), { expirationTtl: 86400 });
        const dl = `${url.origin}/d/${dlTok}`;

        // أرسل للمستخدم النتيجة + حاول رفعه داخل تيليجرام لو حجمه ضمن حد البوت
        try {
          if (ipaBuf.byteLength <= BOT_UPLOAD_LIMIT) {
            const thumbRow = thumbKey
              ? await DB.prepare("SELECT data FROM ipa_thumbs WHERE id = ?").bind(thumbKey).first()
              : null;

            await sendDocumentWithBuffers({
              botToken: BOT_TOKEN,
              chatId: ticket.chat_id,
              fileBuffer: ipaBuf,
              thumbBuffer: thumbRow?.data || null,
              filename: finalName,
              caption: `📦 تم الرفع من صفحة الويب\n🔗 ${dl}`
            });
          }
          await sendMessage(BOT_TOKEN, ticket.chat_id, `✅ جاهز!\n📝 ${finalName}\n🔗 ${dl}`);
        } catch (e) {
          await sendMessage(BOT_TOKEN, ticket.chat_id, `⚠️ تم الحفظ في D1 ولكن تعذّر الإرسال داخل تيليجرام: ${e.message}\n🔗 ${dl}`);
        }

        // لا نحذف التذكرة فورًا—نتركها تستخدم لرفعٍ آخر خلال صلاحيتها
        return new Response("Uploaded OK. يمكنك إغلاق الصفحة.", { status: 200 });
      }

      return new Response("Method Not Allowed", { status: 405 });
    }

    /* ================== Webhook تيليجرام ================== */
    if (url.pathname === "/telegram" && method === "POST") {
      const update = await request.json().catch(() => null);
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
          ipa_size: 0,
          db_key: null,                // مفتاح الملف في D1
          thumb_key: null,             // مفتاح الصورة في D1
          filename: null,
          upload_token: null           // رابط رفع للملفات الكبيرة
        };

      /* ================== أوامر عامة ================== */
      if (msg.text === "/reset") {
        await KV.delete(`state:${chatId}`);
        await sendMessage(BOT_TOKEN, chatId, "🔄 تم تصفير الجلسة. أرسل /start للبدء.");
        return json({ ok: true });
      }

      if (msg.text === "/start" || msg.text === "/link") {
        if (!state.upload_token) {
          state.upload_token = cryptoRandomId();
          await KV.put(`upl:${state.upload_token}`, JSON.stringify({ chat_id: chatId }), { expirationTtl: 86400 });
        }
        const upl = `${url.origin}/u/${state.upload_token}`;

        state.step = "awaiting_ipa";
        state.ipa_size = 0;
        state.db_key = null;
        state.thumb_key = null;
        state.filename = null;
        await KV.put(`state:${chatId}`, JSON.stringify(state));

        await sendMessage(
          BOT_TOKEN,
          chatId,
          `👋 أهلاً بك في بوت RY7YY IPA!\n\n📌 **الخطوات**:\n1️⃣ أرسل **ملف IPA**.\n2️⃣ أرسل **صورة/Thumbnail** (اختياري).\n3️⃣ أرسل **اسم الملف** مثل: \`RY7YY.ipa\`.\n\n⚠️ إن كان الملف كبيرًا بحيث لا يمكن تنزيله عبر Bot API:\nاستخدم رابط الرفع الآمن الخاص بك:\n${upl}\n\nبعد الرفع، سيصلك الإرسال والرابط تلقائيًا.`
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

        state.ipa_size = Number(doc.file_size || 0);

        const status = await sendMessage(
          BOT_TOKEN,
          chatId,
          `⏳ جاري معالجة الملف: ${formatBytes(state.ipa_size)}...`
        );

        // نحاول تنزيله من تيليجرام فقط إذا كان ضمن حد التنزيل (≈20MB)
        if (state.ipa_size <= 20 * 1024 * 1024) {
          try {
            const fileInfo = await getFile(BOT_TOKEN, doc.file_id);   // يوفّر file_path
            const tgUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
            const tgResp = await fetch(tgUrl);
            if (!tgResp.ok) throw new Error("Failed to download IPA from Telegram");

            const buf = await tgResp.arrayBuffer();
            const dbKey = "ipa_" + cryptoRandomId();
            await DB.prepare(
              "INSERT INTO ipa_files (id, filename, size, data, uploaded_at) VALUES (?, ?, ?, ?, ?)"
            ).bind(dbKey, doc.file_name || "app.ipa", state.ipa_size, buf, Date.now()).run();

            state.db_key = dbKey;
            state.step = "awaiting_image";
            await KV.put(`state:${chatId}`, JSON.stringify(state));

            await editMessageText(BOT_TOKEN, chatId, status.message_id, "✅ تم حفظ ملف IPA في D1.\n📸 الآن أرسل صورة (اختياري).");
            return json({ ok: true });
          } catch (e) {
            await editMessageText(BOT_TOKEN, chatId, status.message_id, "⚠️ تعذّر تنزيل الملف من تيليجرام.\nأرسل /link للحصول على رابط رفع.");
            return json({ ok: true });
          }
        } else {
          // كبير: نرشّح له استخدام رابط الرفع
          if (!state.upload_token) {
            state.upload_token = cryptoRandomId();
            await KV.put(`upl:${state.upload_token}`, JSON.stringify({ chat_id: chatId }), { expirationTtl: 86400 });
          }
          const upl = `${url.origin}/u/${state.upload_token}`;
          await editMessageText(
            BOT_TOKEN,
            chatId,
            status.message_id,
            `⚠️ الملف كبير ولا يمكن تنزيله عبر Bot API.\n⬆️ استخدم رابط الرفع:\n${upl}`
          );
          // نسمح بمتابعة إرسال الصورة ثم الاسم إن أحب، لكن الربط الفعلي سيكون بعد الرفع من الصفحة
          state.step = "awaiting_image";
          await KV.put(`state:${chatId}`, JSON.stringify(state));
          return json({ ok: true });
        }
      }

      /* ================== استقبال صورة ================== */
      if (msg.photo && state.step === "awaiting_image") {
        const best = msg.photo[msg.photo.length - 1];
        try {
          const info = await getFile(BOT_TOKEN, best.file_id);
          if (info?.file_path) {
            const imgUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${info.file_path}`;
            const imgResp = await fetch(imgUrl);
            if (imgResp.ok) {
              const buf = await imgResp.arrayBuffer();
              const key = "th_" + cryptoRandomId();
              await DB.prepare(
                "INSERT INTO ipa_thumbs (id, ipa_id, data, content_type, created_at) VALUES (?, ?, ?, ?, ?)"
              ).bind(key, state.db_key || "", buf, "image/jpeg", Date.now()).run();
              state.thumb_key = key;
            }
          }
        } catch {}
        state.step = "awaiting_name";
        await KV.put(`state:${chatId}`, JSON.stringify(state));

        await sendMessage(BOT_TOKEN, chatId, "✅ تم حفظ الصورة (إن وُجدت).\n✍️ أرسل الآن اسم الملف مثل: `RY7YY.ipa`", "Markdown");
        return json({ ok: true });
      }

      /* ================== استقبال الاسم + التحضير + الإرسال ================== */
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
          if (state.db_key) {
            const row = await DB.prepare("SELECT data, size FROM ipa_files WHERE id = ?").bind(state.db_key).first();
            if (!row) throw new Error("file not found in D1");

            // نأتي بالصورة (إن وُجدت) من D1
            const thumbRow = state.thumb_key
              ? await DB.prepare("SELECT data FROM ipa_thumbs WHERE id = ?").bind(state.thumb_key).first()
              : null;

            // لو الحجم يسمح، نرفع داخل تيليجرام بالاسم الجديد + الأيقونة
            if (Number(row.size || 0) <= BOT_UPLOAD_LIMIT) {
              await sendDocumentWithBuffers({
                botToken: BOT_TOKEN,
                chatId,
                fileBuffer: row.data,
                thumbBuffer: thumbRow?.data || null,
                filename: state.filename,
                caption: downloadLink ? `🔗 ${downloadLink}` : "📦 ملف جاهز"
              });

              await editMessageText(
                BOT_TOKEN,
                chatId,
                prep.message_id,
                `✅ تم الإرسال داخل تيليجرام بالاسم الجديد والأيقونة.${
                  downloadLink ? `\n🔗 رابط التنزيل: ${downloadLink}` : ""
                }`
              );
            } else {
              // كبير على رفع تيليجرام للبوت—نكتفي بالرابط
              await editMessageText(
                BOT_TOKEN,
                chatId,
                prep.message_id,
                `✅ تم التجهيز!\n📝 ${state.filename}\n📦 الحجم: ${formatBytes(row.size)}\n🔗 ${downloadLink || "—"}`
              );
            }
          } else {
            // لا نملك الملف بعد (لم يُرفع من الرابط)
            await editMessageText(
              BOT_TOKEN,
              chatId,
              prep.message_id,
              `ℹ️ لم نعثر على الملف في D1 بعد.\nأرسل /link للحصول على رابط الرفع، ثم أعد إرسال الاسم بعد الرفع.`
            );
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

        // إنهاء الجلسة
        await KV.delete(`state:${chatId}`);
        return json({ ok: true });
      }

      // ====== رد افتراضي ======
      if (msg.text && !["/start", "/reset", "/link"].includes(msg.text)) {
        await sendMessage(BOT_TOKEN, chatId, "ℹ️ اكتب /start للبدء أو /link للحصول على رابط الرفع أو /reset لإعادة الضبط.");
      }
      return json({ ok: true });
    }

    // صفحة فحص
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "RY7YY Telegram Bot ✅\n• جلسات عبر KV فقط\n• تخزين ملفات عبر D1\n• إرسال داخل تيليجرام بالاسم + الأيقونة (حسب الحد)\n",
        { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    return new Response("Not Found", { status: 404 });
  }
};

/* =================== أدوات مساعدة =================== */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
function sanitizeFilename(name) { return name.replace(/[^a-zA-Z0-9._\u0600-\u06FF-]+/g, "_"); }
function cryptoRandomId() { const b=new Uint8Array(16); crypto.getRandomValues(b); return [...b].map(x=>x.toString(16).padStart(2,"0")).join(""); }
function parseOwnerIds(raw){ if(!raw) return new Set(); return new Set(String(raw).split(",").map(s=>Number(s.trim())).filter(n=>Number.isFinite(n))); }
function formatBytes(n){ if(!n||n<=0) return "0 B"; const u=["B","KB","MB","GB","TB"]; const i=Math.floor(Math.log(n)/Math.log(1024)); return `${(n/Math.pow(1024,i)).toFixed(1)} ${u[i]}`; }
async function sleep(ms){ await new Promise(r=>setTimeout(r,ms)); }

async function ensureSchema(DB){
  // ipa_files
  await DB.prepare(`CREATE TABLE IF NOT EXISTS ipa_files (
    id TEXT PRIMARY KEY,
    filename TEXT,
    size INTEGER,
    data BLOB,
    uploaded_at INTEGER
  )`).run();

  // ipa_thumbs
  await DB.prepare(`CREATE TABLE IF NOT EXISTS ipa_thumbs (
    id TEXT PRIMARY KEY,
    ipa_id TEXT,
    data BLOB,
    content_type TEXT,
    created_at INTEGER
  )`).run();
}

async function isAllowedUser({ token, channelUserName, userId, ownerIds }) {
  try {
    if (ownerIds && ownerIds.has(Number(userId))) return true;
    const url = `https://api.telegram.org/bot${token}/getChatMember?chat_id=@${channelUserName}&user_id=${userId}`;
    const resp = await fetch(url);
    const data = await resp.json().catch(() => ({}));
    if (!data.ok) return ownerIds && ownerIds.has(Number(userId));
    const st = data.result?.status;
    return ["creator","administrator","member"].includes(st);
  } catch {
    return ownerIds && ownerIds.has(Number(userId));
  }
}

async function sendMessage(token, chatId, text, parseMode){
  const body={ chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body)
  });
}
async function editMessageText(token, chatId, messageId, text){
  await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text })
  });
}
async function getFile(token, fileId){
  const resp = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const data = await resp.json();
  if (!data.ok) throw new Error("Failed to fetch file info");
  return data.result;
}

/** رفع داخل تيليجرام من بافر (مع thumbnail اختياري) */
async function sendDocumentWithBuffers({ botToken, chatId, fileBuffer, thumbBuffer, filename, caption }){
  const boundary = "----RY7YYBoundary" + cryptoRandomId();
  const enc = new TextEncoder();

  const partHeader = (name, filename, ctype) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename?`; filename="${filename}"`:""}\r\n${ctype?`Content-Type: ${ctype}\r\n`:""}\r\n`;

  const chunks = [];
  chunks.push(enc.encode(partHeader("chat_id") + chatId + "\r\n"));
  if (caption) chunks.push(enc.encode(partHeader("caption") + caption + "\r\n"));

  // المستند
  chunks.push(enc.encode(partHeader("document", sanitizeFilename(filename || "app.ipa"), "application/octet-stream")));
  chunks.push(fileBuffer);
  chunks.push(enc.encode("\r\n"));

  // الصورة كـ thumbnail إن وُجدت
  if (thumbBuffer) {
    chunks.push(enc.encode(partHeader("thumbnail", "thumb.jpg", "image/jpeg")));
    chunks.push(thumbBuffer);
    chunks.push(enc.encode("\r\n"));
  }

  chunks.push(enc.encode(`--${boundary}--\r\n`));

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: new Blob(chunks)
  });
  const data = await res.json().catch(()=>({}));
  if (!data.ok) throw new Error(data.description || `HTTP ${res.status}`);
}

/* ========== صفحة رفع الملفات عبر /u/:id ========== */
if (url.pathname.startsWith("/u/")) {
  const token = url.pathname.slice(3); // أخذ الكود من الرابط
  if (!token) return new Response("Bad request", { status: 400 });

  // HTML بسيط يعرض فورم رفع IPA + صورة اختيارية
  const html = `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8"/>
  <title>رفع ملف IPA (رابط مؤقت)</title>
  <style>
    body { font-family: sans-serif; padding: 20px; background: #fafafa; }
    h2 { color: #444; }
    input { margin: 8px 0; }
    button { padding: 8px 16px; background: #0078ff; color: #fff; border: none; cursor: pointer; }
    button:hover { background: #005fcc; }
  </style>
</head>
<body>
  <h2>📦 رفع IPA (رابط مؤقت)</h2>
  <form method="POST" action="/upload" enctype="multipart/form-data">
    <label>📂 ملف IPA:</label><br/>
    <input type="file" name="ipa" required /><br/><br/>

    <label>🖼️ صورة (اختياري):</label><br/>
    <input type="file" name="thumb" /><br/><br/>

    <label>✍️ الاسم المطلوب:</label><br/>
    <input type="text" name="filename" value="app.ipa" required /><br/><br/>

    <input type="hidden" name="token" value="${token}" />
    <button type="submit">رفع الآن</button>
  </form>
  <p style="margin-top:20px; color:#666;">هذا الرابط مخصص ومؤقت. الرمز: ${token}</p>
</body>
</html>
`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

return new Response("Not Found", { status: 404 });
}