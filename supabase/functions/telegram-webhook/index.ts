import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";const tg = Deno.env.get("TELEGRAM_TOKEN") || Deno.env.get("BOT_TOKEN");
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

type Step = { id: string; provider: string; model_alias: string; action: string };

async function telegram(method: string, body: Record<string, unknown>) {
  const r = await fetch("https://api.telegram.org/bot" + tg + "/" + method, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok || !data.ok) throw new Error(JSON.stringify(data));
  return data;
}

function keyboard(runId: string, final = false) {
  return { inline_keyboard: [[
    { text: final ? "✅ تأیید نهایی و اتمام" : "🚀 تأیید و اجرا", callback_data: "wf:" + (final ? "approve" : "start") + ":" + runId },
    { text: "❌ لغو", callback_data: "wf:cancel:" + runId },
  ]] };
}

async function model(step: Step, query: string, input: string, project: string) {
  const prompt = "Project: " + project + ". Step: " + step.action + ". Answer briefly in Persian. Original request: " + query + "\n\nPrevious output:\n" + input;
  if (step.provider === "anthropic") {
    const key = Deno.env.get("ANTHROPIC_API_KEY"); if (!key) throw new Error("ANTHROPIC_API_KEY missing");
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: step.model_alias, max_tokens: 1200, messages: [{ role: "user", content: prompt }] }) });
    const d = await r.json(); if (!r.ok) throw new Error("Claude: " + JSON.stringify(d));
    return (d.content || []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n");
  }
  if (step.provider === "openai") {
    const key = Deno.env.get("OPENAI_API_KEY"); if (!key) throw new Error("OPENAI_API_KEY missing");
    const r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key }, body: JSON.stringify({ model: step.model_alias, temperature: 0.2, messages: [{ role: "system", content: prompt }, { role: "user", content: input }] }) });
    const d = await r.json(); if (!r.ok) throw new Error("OpenAI: " + JSON.stringify(d)); return d.choices?.[0]?.message?.content || "No output";
  }
  if (step.provider === "google") {
    const key = Deno.env.get("GEMINI_API_KEY"); if (!key) throw new Error("GEMINI_API_KEY missing");
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + step.model_alias + ":generateContent?key=" + key, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ system_instruction: { parts: [{ text: prompt }] }, contents: [{ role: "user", parts: [{ text: input }] }] }) });
    const d = await r.json(); if (!r.ok) throw new Error("Gemini: " + JSON.stringify(d)); return d.candidates?.[0]?.content?.parts?.[0]?.text || "No output";
  }
  throw new Error("Unsupported provider");
}

async function run(id: string, chatId: number, messageId: number) {
  const { data: run, error } = await db.from("workflow_runs").select("*, workflow_templates(steps)").eq("id", id).single();
  if (error || !run) throw new Error("Run not found");
  const steps = (run.workflow_templates?.steps || []) as Step[];
  let i = run.current_step_index, input = run.user_query;
  const { data: last } = await db.from("workflow_run_steps").select("output").eq("run_id", id).eq("status", "completed").order("step_index", { ascending: false }).limit(1).maybeSingle();
  if (last?.output) input = last.output;
  while (i < steps.length) {
    const step = steps[i];
    if (step.action === "approval_gate") {
      await db.from("workflow_runs").update({ status: "awaiting_approval", current_step_index: i, updated_at: new Date().toISOString() }).eq("id", id);
      await telegram("editMessageText", { chat_id: chatId, message_id: messageId, text: "🛑 گیت تأیید نهایی\n\nسه مرحله اجرا شد و خروجی‌ها ذخیره شدند. تأیید می‌کنی؟", reply_markup: keyboard(id, true) }); return;
    }
    await telegram("editMessageText", { chat_id: chatId, message_id: messageId, text: "⏳ در حال اجرای مرحله " + (i + 1) + ": " + step.model_alias + " → " + step.action });
    const { data: record, error: e } = await db.from("workflow_run_steps").insert({ run_id: id, step_index: i, step_id: step.id, provider: step.provider, model_alias: step.model_alias, action: step.action, status: "running", inputs: { user_query: run.user_query }, started_at: new Date().toISOString() }).select("id").single();
    if (e || !record) throw new Error("Cannot create step");
    try {
      const output = await model(step, run.user_query, input, run.project);
      await db.from("workflow_run_steps").update({ status: "completed", output, completed_at: new Date().toISOString() }).eq("id", record.id);
      await db.from("messages").insert({ telegram_user_id: run.chat_id, project_slug: run.project, role: "assistant", content: output });
      input = output; i += 1;
      await db.from("workflow_runs").update({ status: "running", current_step_index: i, updated_at: new Date().toISOString() }).eq("id", id);
    } catch (x) {
      const error = x instanceof Error ? x.message : String(x);
      await db.from("workflow_run_steps").update({ status: "failed", error, completed_at: new Date().toISOString() }).eq("id", record.id);
      await db.from("workflow_runs").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", id);
      await telegram("editMessageText", { chat_id: chatId, message_id: messageId, text: "❌ اجرا متوقف شد.\n" + error }); return;
    }
  }
}

async function update(u: any) {
  if (u.callback_query) {
    const c = u.callback_query, [prefix, action, id] = String(c.data || "").split(":");
    if (prefix !== "wf" || !id) return;
    await telegram("answerCallbackQuery", { callback_query_id: c.id });
    if (action === "cancel") { await db.from("workflow_runs").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", id); await telegram("editMessageText", { chat_id: c.message.chat.id, message_id: c.message.message_id, text: "❌ پایپ‌لاین لغو شد." }); return; }
    if (action === "approve") { await db.from("workflow_runs").update({ status: "completed", updated_at: new Date().toISOString() }).eq("id", id); await telegram("editMessageText", { chat_id: c.message.chat.id, message_id: c.message.message_id, text: "🏁 تأیید شد؛ نتیجه در حافظه ثبت شد." }); return; }
    if (action === "start") return await run(id, c.message.chat.id, c.message.message_id);
    return;
  }
  const m = u.message, text = m?.text?.trim(), userId = m?.from?.id, chatId = m?.chat?.id;
  if (!text || !userId || !chatId) return;
  if (text === "/start") { await telegram("sendMessage", { chat_id: chatId, text: "🤖 3AIs Hub آماده است. پرسش را بفرست؛ اول تأیید می‌گیرم." }); return; }
  const { data: s } = await db.from("user_sessions").select("active_project_slug").eq("telegram_user_id", userId).maybeSingle();
  const project = s?.active_project_slug || "general";
  await db.from("messages").insert({ telegram_user_id: userId, project_slug: project, role: "user", content: text });
  const { data: r, error } = await db.from("workflow_runs").insert({ chat_id: userId, project, user_query: text, template_id: "tmpl_research_flow", status: "queued" }).select("id").single();
  if (error || !r) throw new Error("Cannot create run");
  const card = "📋 تأیید اجرای پایپ‌لاین 3AIs\n────────────────────\nپرسش: " + text + "\nپروژه: " + project + "\n\n1. Claude → Web Research\n2. GPT → Analyze & Synthesize\n3. Gemini → Validate & Audit\n4. تأیید نهایی کاربر\n────────────────────\nآیا اجرا شود؟";
  await telegram("sendMessage", { chat_id: chatId, text: card, reply_markup: keyboard(r.id) });
}

serve(async (req) => {
  if (req.method === "GET") return Response.json({ ok: true, engine: "workflow-state-machine" });
  try { const u = await req.json(); /* @ts-ignore */ if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) { /* @ts-ignore */ EdgeRuntime.waitUntil(update(u)); } else await update(u); } catch (e) { console.error(e); }
  return Response.json({ ok: true });
});
