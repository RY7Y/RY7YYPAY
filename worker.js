export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const BOT_TOKEN = env.BOT_TOKEN;
    const CHANNEL_USERNAME = String(env.CHANNEL_USERNAME || "RY7DY").replace(/^@/, "");
    const OWNER_IDS = parseOwnerIds(env.OWNER_IDS || "");
    if (!BOT_TOKEN) return json({ error: "Missing BOT_TOKEN" }, 500);

    // Webhook
    if (url.pathname === "/telegram" && request.method === "POST") {
      const update = await request.json().catch(() => null);
      if (!update) return json({ ok: false }, 400);

      const msg = update.message || update.edited_message;
      if (!msg) return json({ ok: true });
      const chatId = msg.chat.id;
      const userId = msg.from?.id;

      // التحقق من الاشتراك/المالكين
      const allowed = await isAllowedUser({ token: BOT_TOKEN, channelUserName: CHANNEL_USERNAME, userId, ownerIds: OWNER_IDS });
      if (!allowed) {
        await sendSubscribePrompt(BOT_TOKEN, chatId, CHANNEL_USERNAME);
        return json({ ok: true });
      }

      // إشعار مؤقت يؤكّد الاشتراك (يحذف بعد 3 ثوانٍ) — نظهره عند /start فقط كي لا نزعج المستخدم دومًا
      if (msg.text === "/start") {
        const okNote = await sendMessage(
          BOT_TOKEN,
          chatId,
          boxNote(
            "تم التحقق من الاشتراك",
            "عضويتك في القناة نشطة ويمكنك استخدام جميع مزايا البوت."
          ),
          "Markdown"
        );
        waitAndDelete(BOT_TOKEN, chatId, okNote?.message_id, 3000).catch(() => {});
      }

      // حالة الجلسة
      let state = (await env.SESSION_KV.get(`state:${chatId}`, { type: "json" })) || {
        step: "awaiting_ipa",
        ipa_file_id: null,
        ipa_path: null,
        image_file_id: null,
        image_path: null,
        filename: null
      };

      // قفل مضاد للتكرار أثناء الإرسال
      const lockKey = `lock:${chatId}`;

      // أوامر
      if (msg.text === "/reset") {
        await env.SESSION_KV.delete(`state:${chatId}`);
        await env.SESSION_KV.delete(lockKey).catch(() => {});
        await sendMessage(BOT_TOKEN, chatId, boxTitle("تمت إعادة الضبط") + "\nأرسل /start للبدء من جديد.");
        return json({ ok: true });
      }

      if (msg.text === "/help") {
        await sendMessage(
          BOT_TOKEN,
          chatId,
          boxTitle("مساعدة") +
            "\n1) أرسل ملف IPA\n2) أرسل صورة للأيقونة\n3) أرسل الاسم الجديد مثل: MyApp.ipa\n\nسيقوم البوت بإعادة رفع الملف داخل تيليجرام بالاسم الجديد مع الأيقونة."
        );
        return json({ ok: true });
      }

      if (msg.text === "/start") {
        // أوامر السلاش
        await ensureCommands(BOT_TOKEN);

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
          banner("RY7YY IPA Gold") +
            "\n" +
            stepLine(1, "أرسل ملف IPA.") +
            "\n" +
            stepLine(2, "أرسل صورة لاستخدامها كأيقونة.") +
            "\n" +
            stepLine(3, "أرسل الاسم الجديد بصيغة .ipa مثل: MyApp.ipa.")
        );
        return json({ ok: true });
      }

      // استلام IPA
      if (msg.document && state.step === "awaiting_ipa") {
        const doc = msg.document;
        if (!/\.ipa$/i.test(doc.file_name || "")) {
          await sendMessage(BOT_TOKEN, chatId, boxWarn("يجب أن يكون الملف بصيغة .ipa فقط."));
          return json({ ok: true });
        }

        // نحصل على file_path (سنستخدمه لاحقًا للبثّ المباشر في multipart)
        const info = await getFile(BOT_TOKEN, doc.file_id).catch(() => null);
        if (!info?.file_path) {
          await sendMessage(BOT_TOKEN, chatId, boxWarn("تعذّر استلام الملف. أعد المحاولة."));
          return json({ ok: true });
        }

        state.ipa_file_id = doc.file_id;
        state.ipa_path = info.file_path;
        state.step = "awaiting_image";
        await env.SESSION_KV.put(`state:${chatId}`, JSON.stringify(state));

        await sendMessage(BOT_TOKEN, chatId, boxOk("تم حفظ ملف IPA.") + "\nأرسل الآن صورة للأيقونة.");
        return json({ ok: true });
      }

      // استلام صورة
      if (msg.photo && state.step === "awaiting_image") {
        const best = msg.photo[msg.photo.length - 1];
        const pInfo = await getFile(BOT_TOKEN, best.file_id).catch(() => null);

        state.image_file_id = best.file_id;
        state.image_path = pInfo?.file_path || null;
        state.step = "awaiting_name";
        await env.SESSION_KV.put(`state:${chatId}`, JSON.stringify(state));

        await sendMessage(BOT_TOKEN, chatId, boxOk("تم حفظ الأيقونة.") + "\nأرسل الآن الاسم الجديد مثل: MyApp.ipa");
        return json({ ok: true });
      }

      // استلام الاسم + الإرسال
      if (msg.text && state.step === "awaiting_name") {
        const desired = msg.text.trim();
        if (!/\.ipa$/i.test(desired)) {
          await sendMessage(BOT_TOKEN, chatId, boxWarn("الاسم غير صالح. يجب أن ينتهي بـ .ipa"));
          return json({ ok: true });
        }
        state.filename = desired;

        // تحقّق من القفل لمنع التكرار
        const hasLock = await env.SESSION_KV.get(lockKey);
        if (hasLock) return json({ ok: true }); // تجاهل التكرارات
        await env.SESSION_KV.put(lockKey, "1", { expirationTtl: 120 });

        // عدّاد تحضير فخم
        const prep = await sendMessage(BOT_TOKEN, chatId, progBar(0, "التحضير للإرسال داخل تيليجرام"));
        for (let p = 1; p <= 10; p++) {
          await sleep(700);
          await editMessageText(BOT_TOKEN, chatId, prep.message_id, progBar(p * 10, "التحضير للإرسال داخل تيليجرام")).catch(() => {});
        }

        try {
          // إرسال عبر بثّ مباشر من تيليجرام → تيليجرام (multipart)، مع الأيقونة والاسم الجديد
          await sendDocumentWithThumbnail({
            botToken: BOT_TOKEN,
            chatId,
            ipaPath: state.ipa_path,
            imagePath: state.image_path,
            filename: state.filename
          });

          await editMessageText(BOT_TOKEN, chatId, prep.message_id, boxOk("تم الإرسال بنجاح.") + `\nالاسم: ${state.filename}`);
        } catch (e) {
          // أهم سبب للفشل: قيود تيليجرام على تنزيل الملفات الكبيرة للـ bots
          await editMessageText(
            BOT_TOKEN,
            chatId,
            prep.message_id,
            boxErr("تعذّر الإرسال عبر واجهة البوت.") +
              "\nقد يكون الملف كبيرًا جدًا بالنسبة لـ Bot API لإعادة الرفع بالاسم الجديد.\nجرّب ملفًا أصغر أو قسّم الملف."
          );
        }

        // نهاية الجلسة + فتح القفل
        await env.SESSION_KV.delete(`state:${chatId}`);
        await env.SESSION_KV.delete(lockKey).catch(() => {});
        return json({ ok: true });
      }

      // عرض المساعدة الافتراضية
      if (msg.text && !["/start", "/reset", "/help"].includes(msg.text)) {
        await sendMessage(BOT_TOKEN, chatId, "اكتب /start للبدء أو /help للمساعدة.");
      }
      return json({ ok: true });
    }

    // Root
    return new Response("RY7YY IPA Bot", { status: 200 });
  }
};

/* =================== أدوات مساعدة / تنسيق =================== */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
function parseOwnerIds(raw) {
  return new Set(
    String(raw || "")
      .split(",")
      .map((s) => Number((s || "").trim()))
      .filter((n) => Number.isFinite(n))
  );
}
function sanitizeFilename(name) {
  return String(name || "file.ipa").replace(/[^a-zA-Z0-9._\u0600-\u06FF-]+/g, "_");
}
function cryptoRandomId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

/* === رسائل منسّقة بدون إيموجي (أيقونات نصّية احترافية) === */
function banner(title) {
  const t = ` ${title} `;
  const line = "─".repeat(Math.max(8, t.length + 2));
  return `┌${line}┐\n│${t}│\n└${line}┘`;
}
function boxTitle(t) {
  const s = ` ${t} `;
  const line = "─".repeat(Math.max(6, s.length));
  return `┌${line}┐\n│${s}│\n└${line}┘`;
}
function boxOk(t) {
  return `［✓］ ${t}`;
}
function boxWarn(t) {
  return `［!］ ${t}`;
}
function boxErr(t) {
  return `［×］ ${t}`;
}
function boxNote(title, body) {
  const a = ` ${title} `;
  const b = body;
  const width = Math.max(a.length, b.length) + 2;
  const line = "─".repeat(width);
  const pad = (s) => s + " ".repeat(width - s.length);
  return `┌${line}┐\n│ ${pad(a)}│\n│ ${pad(b)}│\n└${line}┘`;
}
function stepLine(n, text) {
  return `【${n}】 ${text}`;
}
function progBar(percent, label) {
  const p = Math.max(0, Math.min(100, Math.floor(percent)));
  const filled = Math.round(p / 10);
  const bar = "▰".repeat(filled) + "▱".repeat(10 - filled);
  return `${label}\n[${bar}] ${p}%`;
}

/* ============ Telegram helpers ============ */
async function ensureCommands(token) {
  const body = {
    commands: [
      { command: "start", description: "بدء جلسة جديدة" },
      { command: "reset", description: "إعادة الضبط" },
      { command: "help", description: "مساعدة" }
    ]
  };
  await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }).catch(() => {});
}

async function isAllowedUser({ token, channelUserName, userId, ownerIds }) {
  try {
    if (ownerIds && ownerIds.has(Number(userId))) return true;
    const url = `https://api.telegram.org/bot${token}/getChatMember?chat_id=@${channelUserName}&user_id=${userId}`;
    const resp = await fetch(url);
    const data = await resp.json().catch(() => ({}));
    const st = data?.result?.status;
    return ["creator", "administrator", "member"].includes(st);
  } catch {
    return ownerIds && ownerIds.has(Number(userId));
  }
}

async function sendSubscribePrompt(token, chatId, channelUsername) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: boxTitle("الاشتراك مطلوب") + `\nيرجى الانضمام إلى القناة لاستخدام البوت.\nبعد الاشتراك أرسل /start.`,
      reply_markup: {
        inline_keyboard: [[{ text: "فتح القناة", url: `https://t.me/${channelUsername}` }]]
      }
    })
  });
}

async function sendMessage(token, chatId, text, parseMode) {
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  return data?.result || {};
}

async function editMessageText(token, chatId, messageId, text) {
  await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text })
  });
}

async function waitAndDelete(token, chatId, messageId, delayMs) {
  if (!messageId) return;
  await sleep(delayMs || 3000);
  await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId })
  }).catch(() => {});
}

async function getFile(token, fileId) {
  const resp = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const data = await resp.json();
  if (!data.ok) throw new Error("Failed to fetch file info");
  return data.result;
}

/** بثّ مباشر multipart بدون تحميل كل الملف في الذاكرة + دعم thumbnail */
async function sendDocumentWithThumbnail({ botToken, chatId, ipaPath, imagePath, filename }) {
  const ipaUrl = `https://api.telegram.org/file/bot${botToken}/${ipaPath}`;
  const ipaResp = await fetch(ipaUrl);
  if (!ipaResp.ok || !ipaResp.body) throw new Error("فشل تنزيل ملف IPA من تيليجرام (قد يكون كبيرًا لواجهة البوت).");

  let imgResp = null;
  if (imagePath) {
    const imgUrl = `https://api.telegram.org/file/bot${botToken}/${imagePath}`;
    imgResp = await fetch(imgUrl);
    if (!imgResp.ok || !imgResp.body) imgResp = null;
  }

  const boundary = "----RY7YYBoundary" + cryptoRandomId();
  const enc = new TextEncoder();
  const part = (name, file, ctype) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${file ? `; filename="${file}"` : ""}\r\n${
      ctype ? `Content-Type: ${ctype}\r\n` : ""
    }\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;

  const bodyStream = new ReadableStream({
    async start(controller) {
      controller.enqueue(enc.encode(part("chat_id") + chatId + "\r\n"));
      controller.enqueue(enc.encode(part("caption") + `${filename}\r\n`));

      // IPA stream
      controller.enqueue(enc.encode(part("document", sanitizeFilename(filename), "application/octet-stream")));
      await pipeStream(ipaResp.body, controller);
      controller.enqueue(enc.encode("\r\n"));

      // thumbnail اختياري
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

async function pipeStream(src, controller) {
  const reader = src.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    controller.enqueue(value);
  }
}