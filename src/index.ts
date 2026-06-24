import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { tasks } from "./db/schema";
import { eq, and } from "drizzle-orm";


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
        const content = text.slice(2).trim();

        await db.insert(tasks).values({
          userId: event.source?.userId ?? "unknown",
          content,
        });

        
        await replyMessage(c.env.CHANNEL_ACCESS_TOKEN, event.replyToken, `追加したよ: ${content}`);
      } else if (text === "リスト") {
        const userId = event.source?.userId ?? "unknown";
        const rows = await db
          .select()
          .from(tasks)
          .where(and(eq(tasks.userId, userId), eq(tasks.done, 0)));

        const list = rows.map((t) => `${t.id}: ${t.content}`).join("\n");
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
      } else {
        await replyMessage(c.env.CHANNEL_ACCESS_TOKEN, event.replyToken, text);
      }
    }
  }

 

  return c.text("OK");
});


export default app;
