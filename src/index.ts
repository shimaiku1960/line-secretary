import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { tasks } from "./db/schema";
import { eq, and, lte } from "drizzle-orm";


type Bindings = CloudflareBindings & {
  CHANNEL_SECRET: string;
  CHANNEL_ACCESS_TOKEN: string;
  DB: D1Database;
};

const verifySignature = async (
  body: string,
  signature: string | undefined,
  channelSecret: string,
): Promise<boolean> => {
  if (!signature) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  

  const mac = await crypto.subtle.sign(
    "HMAC",
    key, 
    new TextEncoder().encode(body),
  );
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

  return expected === signature;
};

const replyMessage = async (
  accessToken: string,
  replyToken: string,
  text: string,
): Promise<void> => {
  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("LINE reply failed:", response.status, errorBody);
  }
};

// replyToken を使わず userId 宛に能動送信する（Cronからのリマインダー用）。
// Reply API は受信から数分の replyToken が要るが、Push API はいつでも送れる。
const pushMessage = async (
  accessToken: string,
  userId: string,
  text: string,
): Promise<void> => {
  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      to: userId,
      messages: [{ type: "text", text }],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("LINE push failed:", response.status, errorBody);
  }
};

// "MM-DD HH:mm" を JST として解釈し、UNIX秒(UTC)に変換する。
// Workerは常にUTCで動くので、JSTの壁時計から9時間引いてUTC基準にそろえる。
// 形式が違えば null（=期限なしタスク扱い）。
const parseDueJst = (input: string): number | null => {
  const m = input.trim().match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [, mon, day, hour, min] = m;
  const year = new Date().getUTCFullYear();
  const utcMs = Date.UTC(
    year,
    Number(mon) - 1,
    Number(day),
    Number(hour) - 9, // JST(+9) → UTC
    Number(min),
  );
  if (Number.isNaN(utcMs)) return null;
  return Math.floor(utcMs / 1000);
};

// UNIX秒 → "MM-DD HH:mm"(JST) の表示用文字列。
const formatDueJst = (epochSec: number): string => {
  const d = new Date(epochSec * 1000);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())} ${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}`;
};


const app = new Hono<{ Bindings: Bindings }>();

app.get("/message", (c) => {
  return c.text("Hello Hono!");
});

app.post("/webhook", async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("x-line-signature");

  const valid = await verifySignature(rawBody, signature, c.env.CHANNEL_SECRET);
  if (!valid) {
    return c.text("Invalid signature", 401);
  }

  const body = JSON.parse(rawBody) as {
    events: {
      type: string;
      replyToken?: string;
      source?: { userId?: string };
      message?: { type: string; text?: string };
    }[];
  };

  const db = drizzle(c.env.DB);

  for (const event of body.events) {
    if (
      event.type === "message" &&
      event.message?.type === "text" &&
      event.replyToken &&
      event.message.text
    ) {
      const text = event.message.text;

      if (text.startsWith("追加")) {
        // "追加 会議 @06-30 10:00" → 本文と期限(@以降)に分ける。@が無ければ期限なし。
        const rest = text.slice(2).trim();
        const atIndex = rest.indexOf("@");
        const content = (atIndex === -1 ? rest : rest.slice(0, atIndex)).trim();
        const dueAt =
          atIndex === -1 ? null : parseDueJst(rest.slice(atIndex + 1));

        // @を書いたのに形式が不正なら、無言で期限なし登録せず知らせる。
        if (atIndex !== -1 && dueAt === null) {
          await replyMessage(
            c.env.CHANNEL_ACCESS_TOKEN,
            event.replyToken,
            "期限の形式は @06-30 10:00 だよ",
          );
        } else {
          await db.insert(tasks).values({
            userId: event.source?.userId ?? "unknown",
            content,
            dueAt,
          });

          const suffix = dueAt ? `（期限 ${formatDueJst(dueAt)}）` : "";
          await replyMessage(
            c.env.CHANNEL_ACCESS_TOKEN,
            event.replyToken,
            `追加したよ: ${content}${suffix}`,
          );
        }
      } else if (text === "リスト") {
        const userId = event.source?.userId ?? "unknown";
        const rows = await db
          .select()
          .from(tasks)
          .where(and(eq(tasks.userId, userId), eq(tasks.done, 0)));

        const list = rows
          .map(
            (t) =>
              `${t.id}: ${t.content}${t.dueAt ? ` ⏰${formatDueJst(t.dueAt)}` : ""}`,
          )
          .join("\n");
        await replyMessage(
          c.env.CHANNEL_ACCESS_TOKEN,
          event.replyToken,
          list || "タスクはないよ",
        );
      } else if (text.startsWith("完了")) {
        const id = Number(text.slice(2).trim());
        const userId = event.source?.userId ?? "unknown";
        await db
          .update(tasks)
          .set({ done: 1 })
          .where(and(eq(tasks.id, id), eq(tasks.userId, userId)));

        await replyMessage(
          c.env.CHANNEL_ACCESS_TOKEN,
          event.replyToken,
          `完了にしたよ: ${id}`,
        );
      } else if (text.startsWith("削除")) {
        const id = Number(text.slice(2).trim());
        const userId = event.source?.userId ?? "unknown";
        const result = await db
          .delete(tasks)
          .where(and(eq(tasks.id, id), eq(tasks.userId, userId)));

        const deleted = result.meta.changes > 0;
        await replyMessage(
          c.env.CHANNEL_ACCESS_TOKEN,
          event.replyToken,
          deleted ? `削除したよ: ${id}` : `そのタスクはないよ: ${id}`,
        );
      } else {
        await replyMessage(c.env.CHANNEL_ACCESS_TOKEN, event.replyToken, text);
      }
    }
  }

 

  return c.text("OK");
});


// Cron Triggers から毎分呼ばれる。HTTPリクエストとは別の入口なので
// fetch ハンドラとは独立して env を受け取り、期限切れの未通知タスクを拾って送る。
const scheduled = async (
  _event: ScheduledController,
  env: Bindings,
): Promise<void> => {
  const db = drizzle(env.DB);
  const now = Math.floor(Date.now() / 1000);

  // 期限が来ていて、まだ通知しておらず、未完了のタスクだけ。
  const due = await db
    .select()
    .from(tasks)
    .where(
      and(lte(tasks.dueAt, now), eq(tasks.reminded, 0), eq(tasks.done, 0)),
    );

  for (const task of due) {
    await pushMessage(
      env.CHANNEL_ACCESS_TOKEN,
      task.userId,
      `⏰ リマインダー: ${task.content}`,
    );
    // 二重送信を防ぐため、送れたら通知済みに倒す。
    await db
      .update(tasks)
      .set({ reminded: 1 })
      .where(eq(tasks.id, task.id));
  }
};

const handler = {
  fetch: app.fetch,
  scheduled,
};

export default handler;
