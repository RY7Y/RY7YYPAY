export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const BOT_TOKEN = env.BOT_TOKEN;
    const CHANNEL_USERNAME = String(env.CHANNEL_USERNAME || "RY7DY").replace(/^@/, "");
    const OWNER_IDS = parseOwnerIds(env.OWNER_IDS);
    const KV = env.SESSION_KV;

    if (!BOT_TOKEN) return json({ error: "Missing BOT_TOKEN" }, 500);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response("RY7YY IPA Bot ✅", { status: 200 });
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const update = await request.json().catch(() => null);
      if (!update) return json({ ok: false }, 400);

      const evtId = String(update.update_id ?? cryptoRandomId());
      if (await KV.get(`evt:${evtId}`)) return json({ ok: true });
      await KV.put(`evt:${evtId}`, "1", { expirationTtl: 60 });

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
        await sendMessage(BOT_TOKEN, chatId, [
          "⚠️ يتطلب الاستخدام الانضمام إلى القناة:",
          `https://t.me/${CHANNEL_USERNAME}`,
          "",
          "بعد الانضمام أرسل /start."
        ].join("\n"));
        return json({ ok: true });
      }

      let state = (await KV.get(`state:${chatId}`, { type: "json" })) || freshState();

      if (msg.text === "/start") {
        state = freshState();
        await KV.put(`state:${chatId}`, JSON.stringify(state));

        await setMyCommands(BOT_TOKEN).catch(() => {});
        await sendMessage(BOT_TOKEN, chatId, fancyWelcome());
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

      if (msg.document && state.step === "awaiting_ipa") {
        const doc = msg.document;
        if (!/\.ipa$/i.test(doc.file_name || "")) {
          await sendMessage(BOT_TOKEN, chatId, "⚠️ أرسل ملف بصيغة .ipa فقط.");
          return json({ ok: true });
        }

        let path = null;
        try {
          const info = await getFile(BOT_TOKEN, doc.file_id);
          path = info?.file_path || null;
        } catch {}

        state.ipa_file_id = doc.file_id;
        state.ipa_path = path;
        state.step = "awaiting_image";
        await KV.put(`state:${chatId}`, JSON.stringify(state));

        await sendMessage(BOT_TOKEN, chatId, "📌 تم استلام الملف.\nالآن أرسل صورة للأيقونة.");
        return json({ ok: true });
      }

      if (msg.photo && state.step === "awaiting_image") {
        const best = msg.photo[msg.photo.length - 1];
        let imgPath = null;
        try {
          const info = await getFile(BOT_TOKEN, best.file_id);
          imgPath = info?.file_path || null;
        } catch {}

        state.image_file_id = best.file_id;
        state.image_path = imgPath;
        state.step = "awaiting_name";
        await KV.put(`state:${chatId}`, JSON.stringify(state));

        await sendMessage(BOT_TOKEN, chatId, "📌 تم حفظ الأيقونة.\nأرسل الآن الاسم الجديد مثل: MyApp.ipa");
        return json({ ok: true });
      }

      if (msg.text && state.step === "awaiting_name") {
        const desired = (msg.text || "").trim();
        if (!/\.ipa$/i.test(desired)) {
          await sendMessage(BOT_TOKEN, chatId, "⚠️ الاسم يجب أن ينتهي بـ .ipa");
          return json({ ok: true });
        }

        state.filename = desired;
        await KV.put(`state:${chatId}`, JSON.stringify(state));

        const prep = await sendMessage(BOT_TOKEN, chatId, progressFrame(0));

        // 🔥 عداد بسيط 10 خطوات × ثانية واحدة = 10 ثواني
        await liveProgress(BOT_TOKEN, chatId, prep.message_id, 10, 10000);

        try {
          await sendDocumentWithThumbnail({
            botToken: BOT_TOKEN,
            chatId,
            ipaPath: state.ipa_path,
            imagePath: state.image_path,
            filename: state.filename
          });

          await editMessageText(BOT_TOKEN, chatId, prep.message_id, "✅ تم الإرسال بنجاح!\n📂 الاسم: " + state.filename);
        } catch (e) {
          await editMessageText(BOT_TOKEN, chatId, prep.message_id, "⚠️ تعذّر الإرسال: " + (e?.message || "خطأ غير معلوم"));
        }

        await KV.delete(`state:${chatId}`);
        return json({ ok: true });
      }

      return json({ ok: true });
    }

    return new Response("Not Found", { status: 404 });
  }
};

/* =================== أدوات مساعدة =================== */
function freshState() {
  return { step: "awaiting_ipa", ipa_file_id: null, ipa_path: null, image_file_id: null, image_path: null, filename: null };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

function cryptoRandomId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

function fancyWelcome() {
  return [
    "┏━━━━━━━━━━━━━━━━━━━━━━┓",
    "┃     RY7YY IPA Bot     ┃",
    "┗━━━━━━━━━━━━━━━━━━━━━━┛",
    "حوِّل ملف IPA لنسخة أنيقة داخل تيليجرام:",
    "• إعادة تسمية احترافية",
    "• أيقونة مخصّصة",
    "• خطوات بسيطة وسريعة",
    "",
    "ابدأ الآن…"
  ].join("\n");
}

function helpText() {
  return [
    "╭─ مساعدة",
    "│ 1) أرسل ملف IPA",
    "│ 2) أرسل صورة للأيقونة",
    "│ 3) أرسل الاسم الجديد مثل: MyApp.ipa",
    "╰─ سيعيد البوت رفع الملف داخل تيليجرام بالاسم الجديد مع الأيقونة."
  ].join("\n");
}

function progressFrame(pct) {
  const width = 20;
  const filled = Math.round((pct / 100) * width);
  const bar = "▓".repeat(filled) + "░".repeat(width - filled);
  return [
    "┌ التحضير للإرسال",
    `│ [${bar}] ${pct}%`,
    "└ يرجى الانتظار…"
  ].join("\n");
}

async function liveProgress(token, chatId, messageId, steps = 10, totalMs = 10000) {
  for (let i = 1; i <= steps; i++) {
    const pct = Math.round((i / steps) * 100);
    await editMessageText(token, chatId, messageId, progressFrame(pct)).catch(() => {});
    await new Promise(r => setTimeout(r, totalMs / steps));
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
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands })
  });
}

async function sendMessage(token, chatId, text, parseMode, replyMarkup) {
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  if (replyMarkup) body.reply_markup = replyMarkup;
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
  const data = await resp.json().catch(() => ({}));
  if (!data.ok) throw new Error("getFile failed");
  return data.result;
}

async function sendDocumentWithThumbnail({ botToken, chatId, ipaPath, imagePath, filename }) {
  const ipaUrl = `https://api.telegram.org/file/bot${botToken}/${ipaPath}`;
  const ipaResp = await fetch(ipaUrl);
  if (!ipaResp.ok || !ipaResp.body) throw new Error("Failed to fetch IPA");

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
      controller.enqueue(enc.encode(tail));
      controller.close();
    }
  });

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, body: bodyStream
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || `HTTP ${res.status}`);
}

async function pipeStream(srcReadable, controller) {
  const reader = srcReadable.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    controller.enqueue(value);
  }
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._\u0600-\u06FF-]+/g, "_");
}