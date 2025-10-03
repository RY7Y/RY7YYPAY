export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /* ================== الإعدادات ================== */
    const BOT_TOKEN = env.BOT_TOKEN;                                      // إلزامي
    const CHANNEL_USERNAME = String(env.CHANNEL_USERNAME || "RY7DY").replace(/^@/, "");
    const OWNER_IDS = parseOwnerIds(env.OWNER_IDS);                       // "123,456"
    // إن كانت القيمة صغيرة (مثل 50) نعتبرها MB، وإلا نفترض أنها بايت:
    const RAW_LIMIT = Number(env.BOT_UPLOAD_LIMIT_BYTES || 50);
    const BOT_UPLOAD_LIMIT =
      RAW_LIMIT <= 1000 ? RAW_LIMIT * 1024 * 1024 : RAW_LIMIT;            // bytes
    const KV = env.SESSION_KV;

    if (!BOT_TOKEN) return json({ error: "Missing BOT_TOKEN" }, 500);

    /* ================== مسارات عامة ================== */
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "RY7YY IPA Bot is running ✅",
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }

    /* ================== Webhook تيليجرام ================== */
    if (url.pathname === "/telegram" && request.method === "POST") {
      const update = await request.json().catch(() => null);
      if (!update) return json({ ok: false }, 400);

      const msg = update.message || update.edited_message;
      if (!msg) return json({ ok: true });

      const chatId = msg.chat.id;
      const userId = msg.from?.id;

      // قفل منع التكرار لكل رسالة
      const eventId = update.update_id ?? cryptoRandomId();
      const already = await KV.get(`evt:${eventId}`);
      if (already) return json({ ok: true });
      await KV.put(`evt:${eventId}`, "1", { expirationTtl: 60 });

      // تحقق اشتراك
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
          "🔒 للاستخدام يجب الانضمام أولًا إلى القناة:\nhttps://t.me/" + CHANNEL_USERNAME
        );
        return json({ ok: true });
      } else {
        // رسالة “مشترك ✅” تُحذف بعد 3 ثواني
        const ack = await sendMessage(
          BOT_TOKEN,
          chatId,
          "تم التحقق ✅ — أهلًا بك!"
        ).catch(() => null);
        if (ack?.message_id) {
          waitAndDelete(BOT_TOKEN, chatId, ack.message_id, 3000).catch(() => {});
        }
      }

      // حالة الجلسة
      let state =
        (await KV.get(`state:${chatId}`, { type: "json" })) || freshState();

      /* ========== أوامر ========== */
      if (msg.text === "/start") {
        state = freshState();
        await KV.put(`state:${chatId}`, JSON.stringify(state));

        // وضع أوامر البوت
        await setMyCommands(BOT_TOKEN).catch(() => {});

        await sendMessage(
          BOT_TOKEN,
          chatId,
          fancyWelcome()
        );

        await sendMessage(
          BOT_TOKEN,
          chatId,
          "① أرسل ملف IPA.\n② أرسل صورة للأيقونة.\n③ أرسل الاسم الجديد مثل: MyApp.ipa"
        );

        return json({ ok: true });
      }

      if (msg.text === "/help") {
        await sendMessage(
          BOT_TOKEN,
          chatId,
          helpText(),
          undefined,
          {
            inline_keyboard: [[
              { text: "تواصل معنا", url: "https://t.me/RY7YY" }
            ]]
          }
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

        // استخدم getFile إذا أمكن للحصول على path لإعادة الرفع بالاسم الجديد
        let filePath = null;
        try {
          const info = await getFile(BOT_TOKEN, doc.file_id);
          filePath = info?.file_path || null;
        } catch { /* نتجاهل */ }

        state.ipa_file_id = doc.file_id;
        state.ipa_path = filePath;                // إن لم يوجد path سنرسل لاحقًا بالـ file_id
        state.ipa_size = Number(doc.file_size || 0);
        state.step = "awaiting_image";
        await KV.put(`state:${chatId}`, JSON.stringify(state));

        await sendMessage(BOT_TOKEN, chatId, "تم استلام الملف. الآن أرسل صورة (أيقونة).");
        return json({ ok: true });
      }

      /* ========== استقبال صورة ========== */
      if (msg.photo && state.step === "awaiting_image") {
        const best = msg.photo[msg.photo.length - 1];
        let imgPath = null;
        try {
          const info = await getFile(BOT_TOKEN, best.file_id);
          imgPath = info?.file_path || null;
        } catch { /* نتجاهل */ }

        state.image_file_id = best.file_id;
        state.image_path = imgPath;               // نحاول استخدامها كـ thumbnail
        state.step = "awaiting_name";
        await KV.put(`state:${chatId}`, JSON.stringify(state));

        await sendMessage(BOT_TOKEN, chatId, "تم حفظ الأيقونة.\nأرسل الآن الاسم الجديد مثل: MyApp.ipa");
        return json({ ok: true });
      }

      /* ========== استقبال الاسم والإرسال مرة واحدة فقط ========== */
      if (msg.text && state.step === "awaiting_name") {
        const desired = (msg.text || "").trim();
        if (!/\.ipa$/i.test(desired)) {
          await sendMessage(BOT_TOKEN, chatId, "الاسم يجب أن ينتهي بـ .ipa");
          return json({ ok: true });
        }

        // قفل تنفيذ كي لا نرسل مرّتين
        const lockKey = `lock:${chatId}`;
        if (await KV.get(lockKey)) return json({ ok: true });
        await KV.put(lockKey, "1", { expirationTtl: 30 });

        state.filename = desired;
        await KV.put(`state:${chatId}`, JSON.stringify(state));

        // عدّاد تحضير احترافي
        const prep = await sendMessage(BOT_TOKEN, chatId, "جاري التحضير للإرسال داخل تيليجرام…");
        await sendChatAction(BOT_TOKEN, chatId, "upload_document").catch(() => {});
        await fancyCountdown(BOT_TOKEN, chatId, prep.message_id, 8);

        try {
          if (state.ipa_path && state.ipa_size <= BOT_UPLOAD_LIMIT) {
            // إعادة رفع باسم جديد + أيقونة (إن توفّر stream)
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
              "تم الإرسال بنجاح.\nالاسم: " + state.filename
            );
          } else {
            // ملف كبير: إرسال بالـ file_id (لا يمكن تغيير الاسم – قيد Bot API)
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
          await editMessageText(
            BOT_TOKEN,
            chatId,
            prep.message_id,
            "تعذّر الإرسال: " + (e?.message || "خطأ غير معلوم")
          );
        }

        // إنهاء الجلسة ومنع أي تكرار
        await KV.delete(`state:${chatId}`);
        await KV.delete(lockKey);
        return json({ ok: true });
      }

      // إظهار القائمة عند أي نص آخر
      if (msg.text && !["/start", "/help", "/reset"].includes(msg.text)) {
        await sendMessage(
          BOT_TOKEN,
          chatId,
          "أرسل /start للبدء أو /help للمساعدة."
        );
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

async function waitAndDelete(token, chatId, messageId, ms) {
  await new Promise(r => setTimeout(r, ms));
  await deleteMessage(token, chatId, messageId).catch(() => {});
}

async function deleteMessage(token, chatId, messageId) {
  await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId })
  });
}

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

function fancyWelcome() {
  return [
    "┏━━━━━━━━━━━━━━━━┓",
    "┃   RY7YY IPA Bot   ┃",
    "┗━━━━━━━━━━━━━━━━┛",
    "حوّل ملف الـ IPA لنسخة أنيقة داخل تيليجرام:",
    "• إعادة تسمية احترافية",
    "• وضع أيقونة مخصصة",
    "• عملية بسيطة وسريعة",
    "",
    "أرسل الملف الآن…"
  ].join("\n");
}

function helpText() {
  return [
    "╭─ مساعده",
    "│ 1) أرسل ملف IPA",
    "│ 2) أرسل صورة للأيقونة",
    "│ 3) أرسل الاسم الجديد مثل: MyApp.ipa",
    "╰─ سيعيد البوت رفع الملف داخل تيليجرام بالاسم الجديد مع الأيقونة."
  ].join("\n");
}

function progressFrame(pct) {
  const width = 16;
  const filled = Math.round((pct * width) / 100);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return `┌ التحضير\n│ [${bar}] ${pct}%\n└ يرجى الانتظار…`;
}

async function fancyCountdown(token, chatId, messageId, seconds) {
  for (let i = seconds; i >= 0; i--) {
    const pct = Math.round(((seconds - i) / seconds) * 100);
    await editMessageText(token, chatId, messageId, progressFrame(pct)).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));
  }
}

function formatBytes(n) {
  if (!n || n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
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

async function sendChatAction(token, chatId, action) {
  await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: action || "typing" })
  });
}

async function getFile(token, fileId) {
  const resp = await fetch(
    `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`
  );
  const data = await resp.json().catch(() => ({}));
  if (!data.ok) throw new Error("getFile failed");
  return data.result;
}

/** يرفع IPA كـ multipart مع thumbnail واسم جديد (للملفات التي نملك لها file_path) */
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
          partHeader("caption") + sanitizeFilename(filename || "app.ipa") + "\r\n"
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

/** إرسال عبر file_id (للملفات الكبيرة جدًّا) */
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
    // إعادة المحاولة بدون thumbnail إذا رفضتها Bot API
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