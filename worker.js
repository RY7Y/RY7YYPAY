export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const BOT_TOKEN = env.BOT_TOKEN;
    const CHANNEL_USERNAME = String(env.CHANNEL_USERNAME || "RY7DY").replace(/^@/, "");
    const OWNER_IDS = parseOwnerIds(env.OWNER_IDS);
    const RAW_LIMIT = Number(env.BOT_UPLOAD_LIMIT_BYTES || 50);
    const BOT_UPLOAD_LIMIT = RAW_LIMIT <= 1000 ? RAW_LIMIT * 1024 * 1024 : RAW_LIMIT; // bytes
    const KV = env.SESSION_KV;

    if (!BOT_TOKEN) return json({ error: "Missing BOT_TOKEN" }, 500);

    // صحّة التشغيل
    if (url.pathname === "/" || url.pathname === "") {
      return new Response("RY7YY IPA Bot ✅", { status: 200 });
    }

    // Webhook
    if (url.pathname === "/telegram" && request.method === "POST") {
      const update = await request.json().catch(() => null);
      if (!update) return json({ ok: false }, 400);

      // منع التكرار لكل Update
      const evtId = String(update.update_id ?? cryptoRandomId());
      if (await KV.get(`evt:${evtId}`)) return json({ ok: true });
      await KV.put(`evt:${evtId}`, "1", { expirationTtl: 60 });

      const msg = update.message || update.edited_message;
      if (!msg) return json({ ok: true });

      const chatId = msg.chat.id;
      const userId = msg.from?.id;

      // التحقق من الاشتراك (مع استثناء الملاك)
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
          [
            "⚠️ يتطلب الاستخدام الانضمام إلى القناة:",
            `https://t.me/${CHANNEL_USERNAME}`,
            "",
            "بعد الانضمام أرسل /start."
          ].join("\n")
        );
        return json({ ok: true });
      }

      // جلسة
      let state =
        (await KV.get(`state:${chatId}`, { type: "json" })) || freshState();

      /* ========== أوامر ========== */
      if (msg.text === "/start") {
        state = freshState();
        await KV.put(`state:${chatId}`, JSON.stringify(state));

        // أوامر البوت لشريط الأوامر
        await setMyCommands(BOT_TOKEN).catch(() => {});

        // إشعار “تم التحقق” مرة واحدة فقط كل 24 ساعة
        const ackKey = `ack:${chatId}`;
        if (!(await KV.get(ackKey))) {
          const ack = await sendMessage(BOT_TOKEN, chatId, "تم التحقق ✅ — أهلاً بك!");
          if (ack?.message_id) waitAndDelete(BOT_TOKEN, chatId, ack.message_id, 3000).catch(() => {});
          await KV.put(ackKey, "1", { expirationTtl: 86400 });
        }

        await sendMessage(BOT_TOKEN, chatId, fancyWelcome());
        await sendMessage(
          BOT_TOKEN,
          chatId,
          [
            "① أرسل **ملف IPA**.",
            "② أرسل **صورة للأيقونة**.",
            "③ أرسل **الاسم الجديد** مثل: `MyApp.ipa`."
          ].join("\n"),
          "Markdown"
        );
        return json({ ok: true });
      }

      if (msg.text === "/help") {
        await sendMessage(
          BOT_TOKEN,
          chatId,
          helpText(),
          undefined,
          { inline_keyboard: [[{ text: "تواصل معنا", url: "https://t.me/RY7YY" }]] }
        );
        return json({ ok: true });
      }

      if (msg.text === "/reset") {
        await KV.delete(`state:${chatId}`);
        await sendMessage(BOT_TOKEN, chatId, "تمت إعادة الضبط.");
        return json({ ok: true });
      }

      /* ========== استقبال IPA ========== */
      if (msg.document && state.step === "awaiting_ipa") {
        const doc = msg.document;
        if (!/\.ipa$/i.test(doc.file_name || "")) {
          await sendMessage(BOT_TOKEN, chatId, "الرجاء إرسال ملف بصيغة .ipa فقط.");
          return json({ ok: true });
        }

        // نحاول الحصول على file_path (للملفات التي يمكن تنزيلها لإعادة رفعها باسم جديد)
        let path = null;
        try {
          const info = await getFile(BOT_TOKEN, doc.file_id);
          path = info?.file_path || null;
        } catch { /* نتجاهل */ }

        state.ipa_file_id = doc.file_id;
        state.ipa_path = path; // إن لم يوجد path سنرسل لاحقًا عبر file_id
        state.ipa_size = Number(doc.file_size || 0);
        state.step = "awaiting_image";
        await KV.put(`state:${chatId}`, JSON.stringify(state));

        await sendMessage(BOT_TOKEN, chatId, "تم استلام الملف. الآن أرسل صورة للأيقونة.");
        return json({ ok: true });
      }

      /* ========== استقبال الأيقونة ========== */
      if (msg.photo && state.step === "awaiting_image") {
        const best = msg.photo[msg.photo.length - 1];
        let imgPath = null;
        try {
          const info = await getFile(BOT_TOKEN, best.file_id);
          imgPath = info?.file_path || null;
        } catch { /* نتجاهل */ }

        state.image_file_id = best.file_id;
        state.image_path = imgPath;
        state.step = "awaiting_name";
        await KV.put(`state:${chatId}`, JSON.stringify(state));

        await sendMessage(BOT_TOKEN, chatId, "تم حفظ الأيقونة.\nأرسل الآن الاسم الجديد مثل: MyApp.ipa");
        return json({ ok: true });
      }

      /* ========== استقبال الاسم + عدّاد + إرسال مرّة واحدة فقط ========== */
      if (msg.text && state.step === "awaiting_name") {
        const desired = (msg.text || "").trim();
        if (!/\.ipa$/i.test(desired)) {
          await sendMessage(BOT_TOKEN, chatId, "الاسم يجب أن ينتهي بـ .ipa");
          return json({ ok: true });
        }
        state.filename = desired;
        await KV.put(`state:${chatId}`, JSON.stringify(state));

        // قفل منع التكرار
        const lockKey = `lock:${chatId}`;
        if (await KV.get(lockKey)) return json({ ok: true });
        await KV.put(lockKey, "1", { expirationTtl: 60 });

        const prep = await sendMessage(BOT_TOKEN, chatId, progressFrame(0));
        await sendChatAction(BOT_TOKEN, chatId, "upload_document").catch(() => {});
        // عداد “خرافي” من 0 → 100 ثم يبدأ الإرسال
        await liveProgress(BOT_TOKEN, chatId, prep.message_id, 100);

        try {
          if (state.ipa_path && state.ipa_size <= BOT_UPLOAD_LIMIT) {
            // إعادة رفع باسم جديد مع الأيقونة
            await sendDocumentWithThumbnail({
              botToken: BOT_TOKEN,
              chatId,
              ipaPath: state.ipa_path,
              imagePath: state.image_path,
              filename: state.filename
            });
            await editMessageText(BOT_TOKEN, chatId, prep.message_id, "تم الإرسال بنجاح.\nالاسم: " + state.filename);
          } else {
            // كبير: نرسل بالـ file_id (لا يمكن فرض اسم جديد عند الإرسال بالـ file_id — قيد Bot API)
            await sendDocumentByFileId({
              botToken: BOT_TOKEN,
              chatId,
              fileId: state.ipa_file_id,
              thumbFileId: state.image_file_id,
              caption: state.filename
            });
            await editMessageText(
              BOT_TOKEN,
              chatId,
              prep.message_id,
              "تم الإرسال.\n(قد يظهر اسم الملف الأصلي لقيود تيليجرام)"
            );
          }
        } catch (e) {
          await editMessageText(BOT_TOKEN, chatId, prep.message_id, "تعذّر الإرسال: " + (e?.message || "خطأ غير معلوم"));
        }

        // إنهاء الجلسة
        await KV.delete(`state:${chatId}`);
        await KV.delete(lockKey);
        return json({ ok: true });
      }

      // رد افتراضي
      if (msg.text && !["/start", "/help", "/reset"].includes(msg.text)) {
        await sendMessage(BOT_TOKEN, chatId, "أرسل /start للبدء أو /help للمساعدة.");
      }
      return json({ ok: true });
    }

    return new Response("Not Found", { status: 404 });
  }
};

/* =================== أدوات مساعدة =================== */

function freshState() {
  return {
    step: "awaiting_ipa",
    ipa_file_id: null,
    ipa_path: null,
    ipa_size: 0,
    image_file_id: null,
    image_path: null,
    filename: null
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
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

function cryptoRandomId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

/* ========= رسائل أنيقة بدون إيموجي ========= */

function fancyWelcome() {
  return [
    "┏━━━━━━━━━━━━━━━━━━━━━━┓",
    "┃     RY7YY IPA Bot     ┃",
    "┗━━━━━━━━━━━━━━━━━━━━━━┛",
    "حوِّل ملف IPA لنسخة أنيقة داخل تيليجرام:",
    "• إعادة تسمية احترافية",
    "• أيقونة مخصّصة للرسالة",
    "• خطوات بسيطة وسريعة",
    "",
    "ابدأ بإرسال الملف الآن…"
  ].join("\n");
}

function helpText() {
  return [
    "╭─ مساعدة",
    "│ 1) أرسل ملف IPA",
    "│ 2) أرسل صورة للأيقونة",
    "│ 3) أرسل الاسم الجديد مثل: MyApp.ipa",
    "╰─ سيعيد البوت رفع الملف داخل تيليجرام بالاسم الجديد مع الأيقونة.",
    "",
    "ملاحظـة: عند الملفات الكبيرة جدًا يرسل البوت بالـ file_id (قد يظهر الاسم الأصلي لقيود المنصّة)."
  ].join("\n");
}

/* ========= عدّاد تقدّم احترافي ========= */

function progressFrame(pct) {
  const width = 24;
  const filled = Math.round((pct / 100) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return [
    "┌ التحضير للإرسال",
    `│ [${bar}] ${pct}%`,
    "└ يرجى الانتظار…"
  ].join("\n");
}

async function liveProgress(token, chatId, messageId, steps = 100) {
  // تحديث واقعي الشكل حتى 100%
  const totalMs = 6000; // ~6 ثوانٍ
  for (let i = 0; i <= steps; i++) {
    const pct = i;
    await editMessageText(token, chatId, messageId, progressFrame(pct)).catch(() => {});
    // لتجنب Flood control لا نحدّث بسرعة عالية
    const remain = totalMs / steps;
    await new Promise(r => setTimeout(r, Math.max(40, remain)));
  }
}

/* ========= Telegram Helpers ========= */

async function setMyCommands(token) {
  const commands = [
    { command: "start", description: "ابدأ" },
    { command: "help", description: "مساعدة" },
    { command: "reset", description: "إعادة الضبط" }
  ];
  await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands })
  });
}

async function sendMessage(token, chatId, text, parseMode, replyMarkup) {
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  if (replyMarkup) body.reply_markup = replyMarkup;
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

async function deleteMessage(token, chatId, messageId) {
  await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId })
  });
}
async function waitAndDelete(token, chatId, messageId, ms) {
  await new Promise(r => setTimeout(r, ms));
  await deleteMessage(token, chatId, messageId).catch(() => {});
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
  const data = await resp.json().catch(() => ({}));
  if (!data.ok) throw new Error("getFile failed");
  return data.result;
}

/** إعادة رفع باسم جديد مع thumbnail (يتطلب file_path من تيليجرام) */
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
  const enc = new TextEncoder();
  const part = (name, filename, ctype) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename ? `; filename="${filename}"` : ""}\r\n${ctype ? `Content-Type: ${ctype}\r\n` : ""}\r\n`;

  const tail = `\r\n--${boundary}--\r\n`;

  const bodyStream = new ReadableStream({
    async start(controller) {
      controller.enqueue(enc.encode(part("chat_id") + chatId + "\r\n"));
      controller.enqueue(enc.encode(part("caption") + sanitizeFilename(filename || "app.ipa") + "\r\n"));

      controller.enqueue(enc.encode(part("document", sanitizeFilename(filename || "app.ipa"), "application/octet-stream")));
      await pipeStream(ipaResp.body, controller);
      controller.enqueue(enc.encode("\r\n"));

      if (imgResp && imgResp.body) {
        controller.enqueue(enc.encode(part("thumbnail", "thumb.jpg", "image/jpeg")));
        await pipeStream(imgResp.body, controller);
        controller.enqueue(enc.encode("\r\n"));
      }

      controller.enqueue(enc.encode(tail));
      controller.close();
    }
  });

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: bodyStream
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || `HTTP ${res.status}`);
}

/** إرسال بواسطة file_id (للملفات الكبيرة جدًا) */
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

/* ========= تحقق الاشتراك ========= */
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