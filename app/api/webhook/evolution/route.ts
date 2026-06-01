import { NextResponse } from "next/server";
import { generateText, CoreMessage } from "ai";
import { getLanguageModel } from "@/lib/ai/providers";
import { regularPrompt } from "@/lib/ai/prompts";
import {
  getUser,
  createUser,
  getChatsByUserId,
  saveChat,
  saveMessages,
  getMessagesByChatId,
} from "@/lib/db/queries";
import { generateUUID } from "@/lib/utils";

const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "DbStkTsJfpdDzNYoN3Gm2I0KvcglIvfw";
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || "https://api.evolution.example.com";
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE_NAME || "ClinicaEstetica";

export async function POST(req: Request) {
  try {
    const body = await req.json();

    if (body.event !== "messages.upsert") {
      return NextResponse.json({ status: "ignored", reason: "not messages.upsert" });
    }

    const messageData = body.data?.message;
    const remoteJid = body.data?.key?.remoteJid;
    const fromMe = body.data?.key?.fromMe;

    if (!messageData || !remoteJid || fromMe) {
      return NextResponse.json({ status: "ignored", reason: "invalid message or fromMe" });
    }

    if (remoteJid === "status@broadcast") {
      return NextResponse.json({ status: "ignored", reason: "status update" });
    }

    const incomingText =
      messageData.conversation ||
      messageData.extendedTextMessage?.text ||
      "";

    if (!incomingText.trim()) {
      return NextResponse.json({ status: "ignored", reason: "empty text" });
    }

    const email = `${remoteJid.split('@')[0]}@whatsapp.com`;
    let user = (await getUser(email))[0];

    if (!user) {
      await createUser(email, generateUUID());
      user = (await getUser(email))[0];
    }

    if (!user) {
      throw new Error("Failed to create or fetch user");
    }

    const chatsResult = await getChatsByUserId({
      id: user.id,
      limit: 1,
      startingAfter: null,
      endingBefore: null,
    });
    
    let chat = chatsResult.chats[0];

    if (!chat) {
      const newChatId = generateUUID();
      await saveChat({
        id: newChatId,
        userId: user.id,
        title: `WhatsApp - ${remoteJid}`,
        visibility: "private",
      });
      chat = { id: newChatId, userId: user.id, title: `WhatsApp - ${remoteJid}`, createdAt: new Date(), visibility: "private" };
    }

    const incomingMessageId = generateUUID();
    await saveMessages({
      messages: [
        {
          id: incomingMessageId,
          chatId: chat.id,
          role: "user",
          parts: [{ type: "text", text: incomingText }],
          attachments: [],
          createdAt: new Date(),
        },
      ],
    });

    const dbMessages = await getMessagesByChatId({ id: chat.id });
    
    const coreMessages: CoreMessage[] = dbMessages.map((msg) => {
       const textPart = (msg.parts as any[]).find(p => p.type === 'text')?.text || "";
       return {
         role: msg.role as "user" | "assistant",
         content: textPart,
       };
    });

    const model = getLanguageModel("llama-3.3-70b-versatile");
    
    const { text: generatedResponse } = await generateText({
      model,
      system: regularPrompt,
      messages: coreMessages,
    });

    const outgoingMessageId = generateUUID();
    await saveMessages({
      messages: [
        {
          id: outgoingMessageId,
          chatId: chat.id,
          role: "assistant",
          parts: [{ type: "text", text: generatedResponse }],
          attachments: [],
          createdAt: new Date(),
        },
      ],
    });

    const sendUrl = `${EVOLUTION_API_URL}/message/sendText/${encodeURIComponent(EVOLUTION_INSTANCE)}`;
    const sendResponse = await fetch(sendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": EVOLUTION_API_KEY,
      },
      body: JSON.stringify({
        number: remoteJid.split('@')[0],
        text: generatedResponse,
      }),
    });

    if (!sendResponse.ok) {
      console.error("Failed to send WhatsApp message:", await sendResponse.text());
    }

    return NextResponse.json({ status: "success", text: generatedResponse });
  } catch (error) {
    console.error("Evolution Webhook Error:", error);
    return NextResponse.json(
      { status: "error", message: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
