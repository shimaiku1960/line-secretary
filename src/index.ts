import { Hono } from "hono";

type Bindings = CloudflareBindings & {
  CHANNEL_SECRET: string;
  CHANNEL_ACCESS_TOKEN: string;
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
      message?: { type: string; text?: string };
    }[];
  };

  for (const event of body.events) {
    if (
      event.type === "message" &&
      event.message?.type === "text" &&
      event.replyToken &&
      event.message.text
    ) {
      await replyMessage(
        c.env.CHANNEL_ACCESS_TOKEN,
        event.replyToken,
        event.message.text,
      );
    }
  }

 

  return c.text("OK");
});


export default app;
