export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /* ================== الإعدادات ================== */
    const BOT_TOKEN = env.BOT_TOKEN;                                      // إلزامي
    const CHANNEL_USERNAME = String(env.CHANNEL_USERNAME || "RY7DY").replace(/^@/, "");
    const OWNER_IDS = parseOwnerIds(env.OWNER_IDS);                       // مثال: "123456,987654"
    // حد إعادة الرفع Multipart (محافظين لتفادي مشاكل التيليجرام عند رفع ملفات ضخمة)
    const BOT_UPLOAD_LIMIT = Number(env.BOT_UPLOAD_LIMIT_BYTES || 48 * 1024 * 1024);

    if (!BOT_TOKEN) return json({ error: "Missing BOT_TOKEN" }, 500);

    /* ================== Webhook تيليجرام ================== */
    if (url.pathname === "/telegram" && request.method === "POST") {
      const update = await request.json().catch(() => null);
      if (!update) return json({ ok: false, error: "Invalid update" }, 400);

      const msg = update.message || update.edited_message;
      if (!msg) return json({ ok: true });

      const chatId = msg.chat.id;
      const userId = msg.from?.id;

      /* ===== السماح (اشتراك القناة + وايت ليست) ===== */
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

      /* ===== حالة الجلسة ===== */
      let state =
        (await env.SESSION_KV.get(`state:${chatId}`, { type: "json" })) || {
          step: "awaiting_ipa",   // awaiting_ipa -> awaiting_image -> awaiting_name
          ipa_file_id: null,
          ipa_path: null,         // يُستخدم عند الملفات الصغيرة (لإعادة الرفع باسم جديد)
          ipa_size: 0,
          image_file_id: null,
          image_path: null,       // اختياري
          filename: null
        };

      /* ===== أوامر عامة ===== */
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
          `👋 أهلاً بك في **بوت RY7YY IPA**!

✨ ماذا يفعل البوت؟
• إعادة تسمية ملف IPA كما تريد  
• وضع أيقونة/صورة للملف داخل رسالة تيليجرام  
• **بدون أي روابط تحميل نهائيًا** — كل شيء يتم داخل تيليجرام

📌 خطوات الاستخدام:
1️⃣ أرسل ملف **IPA**.  
2️⃣ أرسل **صورة** (ستُستخدم كأيقونة).  
3️⃣ أرسل **الاسم الجديد** (مثال: \`RY7YY.ipa\`).`,
          "Markdown"
        );
        return json({ ok: true });
      }

      /* ===== استقبال IPA ===== */
      if (msg.document && state.step === "awaiting_ipa") {
        const doc = msg.document;
        if (!/\.ipa$/i.test(doc.file_name || "")) {
          await sendMessage(BOT_TOKEN, chatId, "⚠️ رجاءً أرسل ملف بصيغة .ipa");
          return json({ ok: true });
        }

        state.ipa_file_id = doc.file_id;
        state.ipa_size = Number(doc.file_size || 0);

        // سنحاول الحصول على file_path فقط إن كان الحجم ضمن حد معقول لإعادة الرفع بالاسم الجديد
        if (state.ipa_size <= BOT_UPLOAD_LIMIT) {
          try {
            const info = await getFile(BOT_TOKEN, doc.file_id);
            state.ipa_path = info?.file_path || null;
          } catch {
            state.ipa_path = null; // fallback لاحقًا عبر file_id
          }
        } else {
          state.ipa_path = null;   // كبير → سنرسل via file_id فقط
        }

        state.step = "awaiting_image";
        await env.SESSION_KV.put(`state:${chatId}`, JSON.stringify(state));
        await sendMessage(
          BOT_TOKEN,
          chatId,
          `✅ تم استلام ملف IPA (${formatBytes(state.ipa_size)}).\n📸 أرسل الآن صورة (أيقونة).`
        );
        return json({ ok: true });
      }

      /* ===== استقبال صورة ===== */
      if (msg.photo && state.step === "awaiting_image") {
        const best = msg.photo[msg.photo.length - 1];
        state.image_file_id = best.file_id;

        // الحصول على file_path للصورة (اختياري لإعادة الرفع Multipart)
        try {
          const p = await getFile(BOT_TOKEN, best.file_id);
          state.image_path = p?.file_path || null;
        } catch {
          state.image_path = null;
        }

        state.step = "awaiting_name";
        await env.SESSION_KV.put(`state:${chatId}`, JSON.stringify(state));
        await sendMessage(BOT_TOKEN, chatId, "✅ تم استلام الصورة.\n✍️ أرسل الآن الاسم الجديد مثل: `RY7YY.ipa`", "Markdown");
        return json({ ok: true });
      }

      /* ===== استقبال الاسم + الإرسال داخل تيليجرام فقط ===== */
      if (msg.text && state.step === "awaiting_name") {
        const desired = (msg.text || "").trim();
        if (!/\.ipa$/i.test(desired)) {
          await sendMessage(BOT_TOKEN, chatId, "⚠️ الاسم غير صالح. يجب أن ينتهي بـ .ipa");
          return json({ ok: true });
        }
        state.filename = desired;

        // رسالة تحضير بسيطة
        const prep = await sendMessage(BOT_TOKEN, chatId, "⏳ جاري التحضير للإرسال داخل تيليجرام...");
        await sendChatAction(BOT_TOKEN, chatId, "upload_document").catch(() => {});

        try {
          if (state.ipa_path && state.ipa_size <= BOT_UPLOAD_LIMIT) {
            // ✅ صغير: نعيد رفعه Multipart باسم جديد + thumbnail
            await sendDocumentMultipart({
              botToken: BOT_TOKEN,
              chatId,
              ipaPath: state.ipa_path,
              imagePath: state.image_path,
              filename: state.filename
            });
            await editMessageText(BOT_TOKEN, chatId, prep.message_id, "✅ تم الإرسال بالاسم الجديد والأيقونة داخل تيليجرام.");
          } else {
            // ⚠️ كبير أو لا نملك stream → نرسل عبر file_id (ونحاول تمرير thumbnail عبر file_id للصورة)
            await sendDocumentByFileId({
              botToken: BOT_TOKEN,
              chatId,
              fileId: state.ipa_file_id,
              thumbFileId: state.image_file_id,
              caption: `📦 ${state.filename}`
            });
            await editMessageText(BOT_TOKEN, chatId, prep.message_id, "✅ تم الإرسال داخل تيليجرام.");
          }
        } catch (e) {
          // إعادة محاولة بدون thumbnail لو فشل مع الأيقونة عبر file_id
          if (state.ipa_path && state.ipa_size <= BOT_UPLOAD_LIMIT) {
            await editMessageText(BOT_TOKEN, chatId, prep.message_id, `⚠️ تعذّر الإرسال: ${e.message}`);
          } else {
            try {
              await sendDocumentByFileId({
                botToken: BOT_TOKEN,
                chatId,
                fileId: state.ipa_file_id,
                thumbFileId: null,
                caption: `📦 ${state.filename}`
              });
              await editMessageText(BOT_TOKEN, chatId, prep.message_id, "✅ تم الإرسال داخل تيليجرام (بدون أيقونة بسبب قيود API).");
            } catch (e2) {
              await editMessageText(BOT_TOKEN, chatId, prep.message_id, `⚠️ تعذّر الإرسال: ${e2.message}`);
            }
          }
        }

        // إنهاء الجلسة
        await env.SESSION_KV.delete(`state:${chatId}`);
        return json({ ok: true });
      }

      // رد افتراضي
      if (msg.text && !["/start", "/reset"].includes(msg.text)) {
        await sendMessage(BOT_TOKEN, chatId, "ℹ️ اكتب /start للبدء أو /reset لإعادة الضبط.");
      }
      return json({ ok: true });
    }

    /* صفحة فحص بسيطة */
    if (url.pathname === "/" || url.pathname === "") {
      return new Response("RY7YY IPA Bot ✅ (بدون روابط تحميل — إعادة تسمية + أيقونة داخل تيليجرام)", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    return new Response("Not Found", { status: 404 });
  }
};

/* =================== أدوات مساعدة =================== */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
function parseOwnerIds(raw) {
  if (!raw) return new Set();
  return new Set(
    String(raw)
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter(n => Number.isFinite(n))
  );
}
function formatBytes(n) {
  if (!n || n <= 0) return "0 B";
  const u = ["B","KB","MB","GB","TB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n/Math.pow(1024,i)).toFixed(1)} ${u[i]}`;
}
async function isAllowedUser({ token, channelUserName, userId, ownerIds }) {
  try {
    if (ownerIds && ownerIds.has(Number(userId))) return true;
    const resp = await fetch(
      `https://api.telegram.org/bot${token}/getChatMember?chat_id=@${channelUserName}&user_id=${userId}`
    );
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
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
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

/* ========== إرسال داخل تيليجرام (Multipart) مع تغيير الاسم + الأيقونة ========== */
async function sendDocumentMultipart({ botToken, chatId, ipaPath, imagePath, filename }) {
  // احصل على stream لملف IPA
  const ipaUrl = `https://api.telegram.org/file/bot${botToken}/${ipaPath}`;
  const ipaResp = await fetch(ipaUrl);
  if (!ipaResp.ok || !ipaResp.body) throw new Error("Failed to fetch IPA stream");

  // الصورة اختيارية
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
      controller.enqueue(encoder.encode(partHeader("caption") + `📦 ${filename}\r\n`));

      // المستند
      controller.enqueue(
        encoder.encode(
          partHeader("document", filename, "application/octet-stream")
        )
      );
      await pipeStream(ipaResp.body, controller);
      controller.enqueue(encoder.encode("\r\n"));

      // الأيقونة (اختيارية)
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
  if (!data.ok) throw new Error(`sendDocument failed: ${data.description || res.status}`);
}

/* ========== إرسال عبر file_id (مع محاولة thumbnail ثم fallback) ========== */
async function sendDocumentByFileId({ botToken, chatId, fileId, thumbFileId, caption }) {
  const body = { chat_id: chatId, document: fileId, caption: caption || "" };
  if (thumbFileId) body.thumbnail = thumbFileId;

  let resp = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  let data = await resp.json().catch(() => ({}));

  if (!data.ok && thumbFileId) {
    // إعادة المحاولة بدون الأيقونة
    resp = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, document: fileId, caption: caption || "" })
    });
    data = await resp.json().catch(() => ({}));
  }

  if (!data.ok) throw new Error(`send by file_id failed: ${data.description || resp.status}`);
}

/* ========== أداة مساندة لبثّ الـ streams ========== */
async function pipeStream(srcReadable, controller) {
  const reader = srcReadable.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    controller.enqueue(value);
  }
}

function cryptoRandomId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}