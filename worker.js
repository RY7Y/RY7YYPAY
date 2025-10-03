export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const BOT_TOKEN = env.BOT_TOKEN;
    const CHANNEL_USERNAME = String(env.CHANNEL_USERNAME || "RY7DY").replace(/^@/, "");
    const OWNER_IDS = parseOwnerIds(env.OWNER_IDS);
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

      // ✅ تحقق الاشتراك
      const allowed = await isAllowedUser({ token: BOT_TOKEN, channelUserName: CHANNEL_USERNAME, userId, ownerIds: OWNER_IDS });
      if (!allowed) {
        await sendMessageWithButton(
          BOT_TOKEN,
          chatId,
          `⚠️ للوصول إلى البوت:\n\n🔒 يجب الانضمام إلى القناة أولاً:\n📣 [اضغط هنا للانضمام](https://t.me/${CHANNEL_USERNAME})\n\nبعد الاشتراك أرسل /start ✨`,
          "Markdown"
        );
        return json({ ok: true });
      }

      /* ================== أوامر ================== */
      if (msg.text === "/reset") {
        await env.SESSION_KV.delete(`state:${chatId}`);
        await sendMessage(BOT_TOKEN, chatId, "🔄 تم تصفير الجلسة.\nأرسل /start للبدء من جديد ✨");
        return json({ ok: true });
      }

      if (msg.text === "/help") {
        await sendMessage(
          BOT_TOKEN,
          chatId,
          `📖 **قائمة الأوامر المتاحة**:\n\n` +
          `⚡ /start - بدء جلسة جديدة\n` +
          `🗑️ /reset - تصفير الجلسة\n` +
          `ℹ️ /help - عرض هذه القائمة`
          ,"Markdown"
        );
        return json({ ok: true });
      }

      if (msg.text === "/start") {
        const state = {
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
          `👑 **أهلاً وسهلاً بك في بوت RY7YY IPA Gold** ✨\n\n` +
          `🚀 بوت مخصص لإعادة تسمية ملفات IPA مع إضافة أيقونة جذابة.\n\n` +
          `📌 **خطوات الاستخدام**:\n` +
          `1️⃣ أرسل ملف IPA.\n` +
          `2️⃣ أرسل صورة (ستكون الأيقونة).\n` +
          `3️⃣ أرسل الاسم الجديد مثل: \`MyApp.ipa\`\n\n` +
          `💎 استمتع بخدمة سريعة، أنيقة، واحترافية ✨`,
          "Markdown"
        );
        return json({ ok: true });
      }

      /* ================== استلام IPA ================== */
      let state = (await env.SESSION_KV.get(`state:${chatId}`, { type: "json" })) || {};
      if (msg.document && state.step === "awaiting_ipa") {
        const doc = msg.document;
        if (!/\.ipa$/i.test(doc.file_name || "")) {
          await sendMessage(BOT_TOKEN, chatId, "⚠️ رجاءً أرسل ملف بصيغة .ipa فقط.");
          return json({ ok: true });
        }

        try {
          const fileInfo = await getFile(BOT_TOKEN, doc.file_id);
          state.ipa_file_id = doc.file_id;
          state.ipa_path = fileInfo.file_path;
          state.ipa_size = Number(doc.file_size || 0);
          state.step = "awaiting_image";
          await env.SESSION_KV.put(`state:${chatId}`, JSON.stringify(state));
          await sendMessage(BOT_TOKEN, chatId, `✅ تم حفظ ملف IPA (${formatBytes(state.ipa_size)}).\n📸 الآن أرسل صورة للأيقونة.`);
        } catch {
          await sendMessage(BOT_TOKEN, chatId, "⚠️ تعذر استلام الملف.\nأعد المحاولة.");
        }
        return json({ ok: true });
      }

      /* ================== استلام صورة ================== */
      if (msg.photo && state.step === "awaiting_image") {
        const best = msg.photo[msg.photo.length - 1];
        const info = await getFile(BOT_TOKEN, best.file_id).catch(() => null);

        state.image_file_id = best.file_id;
        state.image_path = info?.file_path || null;
        state.step = "awaiting_name";
        await env.SESSION_KV.put(`state:${chatId}`, JSON.stringify(state));

        await sendMessage(BOT_TOKEN, chatId, "✅ تم حفظ الصورة.\n✍️ الآن أرسل الاسم الجديد مثل: `MyApp.ipa`", "Markdown");
        return json({ ok: true });
      }

      /* ================== استلام الاسم + عداد + إرسال ================== */
      if (msg.text && state.step === "awaiting_name") {
        const desired = msg.text.trim();
        if (!/\.ipa$/i.test(desired)) {
          await sendMessage(BOT_TOKEN, chatId, "⚠️ الاسم غير صالح. يجب أن ينتهي بـ .ipa");
          return json({ ok: true });
        }
        state.filename = desired;

        // عداد تحضير فخم
        const prep = await sendMessage(BOT_TOKEN, chatId, `⏳ جاري التحضير للإرسال داخل تيليجرام...`);
        const fancy = ["🔟","9️⃣","8️⃣","7️⃣","6️⃣","5️⃣","4️⃣","3️⃣","2️⃣","1️⃣","🚀"];
        for (let i = 0; i < fancy.length; i++) {
          await sleep(1000);
          await editMessageText(BOT_TOKEN, chatId, prep.message_id, `⏳ التحضير: ${fancy[i]} ...`);
        }

        try {
          await sendDocumentWithThumbnail({
            botToken: BOT_TOKEN,
            chatId,
            ipaPath: state.ipa_path,
            imagePath: state.image_path,
            filename: state.filename
          });
          await sendMessage(BOT_TOKEN, chatId, `✅ تم الإرسال بنجاح!\n📦 الاسم: ${state.filename}`);
        } catch (e) {
          await sendMessage(BOT_TOKEN, chatId, `⚠️ خطأ: ${e.message}`);
        }

        await env.SESSION_KV.delete(`state:${chatId}`);
        return json({ ok: true });
      }

      return json({ ok: true });
    }

    return new Response("RY7YY Telegram Bot ✅", { status: 200 });
  }
};

/* =================== أدوات مساعدة =================== */
function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } }); }
function parseOwnerIds(raw){ if(!raw) return new Set(); return new Set(String(raw).split(",").map(s=>Number(s.trim())).filter(n=>Number.isFinite(n))); }
function formatBytes(n){ if(!n||n<=0) return "0 B"; const u=["B","KB","MB","GB","TB"]; const i=Math.floor(Math.log(n)/Math.log(1024)); return `${(n/Math.pow(1024,i)).toFixed(1)} ${u[i]}`; }
async function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function isAllowedUser({ token, channelUserName, userId, ownerIds }) {
  try {
    if (ownerIds.has(Number(userId))) return true;
    const resp = await fetch(`https://api.telegram.org/bot${token}/getChatMember?chat_id=@${channelUserName}&user_id=${userId}`);
    const data = await resp.json().catch(()=>({}));
    const st = data.result?.status;
    return ["creator","administrator","member"].includes(st);
  } catch { return ownerIds.has(Number(userId)); }
}

async function sendMessage(token, chatId, text, parseMode){
  const body={ chat_id: chatId, text };
  if (parseMode) body.parse_mode=parseMode;
  const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{ "Content-Type":"application/json"},body:JSON.stringify(body)});
  return (await r.json().catch(()=>({}))).result || {};
}

async function sendMessageWithButton(token, chatId, text, parseMode){
  const body={ chat_id: chatId, text, reply_markup:{ inline_keyboard:[[{text:"📣 اشترك بالقناة", url:`https://t.me/${CHANNEL_USERNAME}`}]]}};
  if (parseMode) body.parse_mode=parseMode;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{ "Content-Type":"application/json"},body:JSON.stringify(body)});
}

async function editMessageText(token, chatId, messageId, text){
  await fetch(`https://api.telegram.org/bot${token}/editMessageText`,{method:"POST",headers:{ "Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,message_id:messageId,text})});
}

async function getFile(token, fileId){
  const resp=await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const data=await resp.json();
  if(!data.ok) throw new Error("Failed to get file");
  return data.result;
}

async function sendDocumentWithThumbnail({ botToken, chatId, ipaPath, imagePath, filename }){
  const ipaUrl=`https://api.telegram.org/file/bot${botToken}/${ipaPath}`;
  const ipaResp=await fetch(ipaUrl);
  if(!ipaResp.ok||!ipaResp.body) throw new Error("IPA fetch failed");

  let imgResp=null;
  if(imagePath){ const imgUrl=`https://api.telegram.org/file/bot${botToken}/${imagePath}`; imgResp=await fetch(imgUrl); if(!imgResp.ok||!imgResp.body) imgResp=null; }

  const boundary="----RY7YYBoundary"+cryptoRandomId();
  const enc=new TextEncoder();
  const part=(name,fn,ct)=>`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${fn?`; filename="${fn}"`:""}\r\n${ct?`Content-Type: ${ct}\r\n`:""}\r\n`;

  const chunks=[];
  chunks.push(enc.encode(part("chat_id")+chatId+"\r\n"));
  chunks.push(enc.encode(part("caption")+`📦 ${filename}\r\n`));
  chunks.push(enc.encode(part("document",sanitizeFilename(filename),"application/octet-stream")));
  chunks.push(await ipaResp.arrayBuffer()); chunks.push(enc.encode("\r\n"));
  if(imgResp&&imgResp.body){ chunks.push(enc.encode(part("thumbnail","thumb.jpg","image/jpeg"))); chunks.push(await imgResp.arrayBuffer()); chunks.push(enc.encode("\r\n")); }
  chunks.push(enc.encode(`--${boundary}--\r\n`));

  const res=await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`,{method:"POST",headers:{ "Content-Type":`multipart/form-data; boundary=${boundary}`},body:new Blob(chunks)});
  const data=await res.json().catch(()=>({})); if(!data.ok) throw new Error(data.description||`HTTP ${res.status}`);
}

function sanitizeFilename(name){return name.replace(/[^a-zA-Z0-9._-]+/g,"_");}
function cryptoRandomId(){const b=new Uint8Array(16);crypto.getRandomValues(b);return [...b].map(x=>x.toString(16).padStart(2,"0")).join("");}