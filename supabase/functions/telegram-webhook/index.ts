import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const botToken = "8995146867:AAEPYCpR8R6bmT100SLQpmiBFzECfbIEkSs";
const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(supabaseUrl, supabaseKey);

async function callTg(method: string, body: Record<string, unknown>) {
  try {
    return await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error(`Error calling Telegram ${method}:`, e);
  }
}

async function sendSafeMessage(chatId: number, text: string) {
  // محدودیت طول پیام تلگرام ۴۰۹۶ است
  const maxLength = 4000;
  for (let i = 0; i < text.length; i += maxLength) {
    const chunk = text.substring(i, i + maxLength);
    const res = await callTg("sendMessage", {
      chat_id: chatId,
      text: chunk,
      parse_mode: "Markdown",
    });
    // در صورت خطای ساختار Markdown، همان پیام به عنوان متن ساده فرستاده می‌شود تا بات قطع نشود
    if (!res || !res.ok) {
      await callTg("sendMessage", {
        chat_id: chatId,
        text: chunk,
      });
    }
  }
}

async function handleBackgroundUpdate(update: any) {
  try {
    // ۱. مدیریت دکمه‌های شیشه‌ای
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message.chat.id;
      const data = cb.data;

      if (data && data.startsWith("proj_")) {
        const project = data.replace("proj_", "");
        await supabase.from("chat_sessions").upsert({
          chat_id: chatId,
          active_project: project,
          updated_at: new Date().toISOString()
        });

        await callTg("answerCallbackQuery", { callback_query_id: cb.id, text: `پروژه: ${project}` });
        await callTg("editMessageText", {
          chat_id: chatId,
          message_id: cb.message.message_id,
          text: `🎯 پروژه فعال: **${project}**\n\nحافظه گفتگو فعال است. هر سوالی دارید بفرمایید:`,
          parse_mode: "Markdown",
        });
      }
      return;
    }

    const msg = update.message;
    if (!msg || !msg.text || !msg.chat) return;

    const chatId = msg.chat.id;
    const text = msg.text.trim();

    // پروژه جاری
    const { data: sessionData } = await supabase
      .from("chat_sessions")
      .select("active_project")
      .eq("chat_id", chatId)
      .single();

    const activeProject = sessionData?.active_project || "Mixario";

    if (text === "/start" || text === "/projects") {
      await callTg("sendMessage", {
        chat_id: chatId,
        text: `🤖 **3AIs Hub همیشه آنلاین**\n\nپروژه فعلی: \`${activeProject}\`\nبرای تغییر زمینه انتخاب کنید:`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🎛 Mixario Engine", callback_data: "proj_Mixario" },
              { text: "🎧 Sedamix Marketplace", callback_data: "proj_Sedamix" }
            ],
            [
              { text: "⚡ گفتگوی آزاد", callback_data: "proj_General" }
            ]
          ]
        }
      });
      return;
    }

    if (text === "/clear") {
      await supabase.from("chat_messages").delete().eq("chat_id", chatId).eq("project", activeProject);
      await sendSafeMessage(chatId, `🧹 حافظه گفتگوی پروژه **${activeProject}** پاکسازی شد.`);
      return;
    }

    await callTg("sendChatAction", { chat_id: chatId, action: "typing" });

    if (!geminiApiKey) {
      await sendSafeMessage(chatId, "⚠️ کلید GEMINI_API_KEY تنظیم نشده است.");
      return;
    }

    // واکشی سوابق
    const { data: historyData } = await supabase
      .from("chat_messages")
      .select("role, content")
      .eq("chat_id", chatId)
      .eq("project", activeProject)
      .order("created_at", { ascending: false })
      .limit(8);

    const contents = [];
    if (historyData && historyData.length > 0) {
      for (const item of historyData.reverse()) {
        contents.push({ role: item.role, parts: [{ text: item.content }] });
      }
    }
    contents.push({ role: "user", parts: [{ text }] });

    const systemPrompt = `You are the AI technical co-pilot for 3AIs Hub. Current project: "${activeProject}". Answer insightfully and technically in Persian (Farsi). Keep continuity with conversation history.`;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`;
    const aiRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: contents
      }),
    });

    const aiData = await aiRes.json();
    const replyText = aiData?.candidates?.[0]?.content?.parts?.[0]?.text || "پاسخی دریافت نشد.";

    // ذخیره پیام‌ها
    await supabase.from("chat_messages").insert([
      { chat_id: chatId, project: activeProject, role: "user", content: text },
      { chat_id: chatId, project: activeProject, role: "model", content: replyText }
    ]);

    await sendSafeMessage(chatId, `🧠 **[${activeProject}]**\n\n${replyText}`);

  } catch (err) {
    console.error("Background execution error:", err);
  }
}

serve(async (req) => {
  if (req.method === "GET") {
    return new Response(JSON.stringify({ ok: true, status: "stable-background-worker" }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const update = await req.json();

    // ارسال فوری پاسخ 200 به تلگرام در کسری از ثانیه و ادامه پردازش در پس‌زمینه
    // این تکنیک مانع قطعی وب‌هوک به دلیل تاخیر هوش مصنوعی می‌شود
    // @ts-ignore
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(handleBackgroundUpdate(update));
    } else {
      handleBackgroundUpdate(update);
    }
  } catch (e) {
    console.error("Request parse error:", e);
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
    status: 200
  });
});
