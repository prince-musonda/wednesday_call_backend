import "dotenv/config";
import Fastify from "fastify";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import { randomUUID } from "node:crypto";
import { fromEnv } from "@aws-sdk/credential-providers";
import { S2SBidirectionalStreamClient, StreamSession } from "./nova-client";
import { toolProcessor } from "./mock-tools";
import { mulaw } from "alawmulaw";
import { Twilio } from "twilio";
import { readFileSync } from "node:fs";

//read the audio bytes from hello.pcm file
const helloAudioBytes = readFileSync("assets/hello.pcm");

// Find your Account SID and Auth Token at twilio.com/console
// and set the environment variables. See http://twil.io/secure

const apiSid = process.env.TWILIO_API_SID;
const apiSecret = process.env.TWILIO_API_SECRET;
const accountSid = process.env.TWILIO_ACCOUNT_SID;

const fromNumber = process.env.TWILIO_FROM_NUMBER;

const twClient = new Twilio(apiSid, apiSecret, { accountSid });

function buildSystemPrompt(orgName: string, orgId: string): string {
  return (
    `You are a friendly and knowledgeable 24/7 assistant for "${orgName}" (organisation id: ${orgId}). ` +
    `The user and you will engage in a spoken dialog exchanging the transcripts of a natural real-time conversation. ` +
    `Keep your responses clear, helpful, and concise — generally two or three sentences unless more detail is genuinely needed. ` +
    `Whenever you need information to answer a question about "${orgName}", use the queryKnowledgeBase tool with orgId "${orgId}" and your question as the query. ` +
    `Only answer questions that are relevant to "${orgName}". ` +
    `If the caller asks about a different organisation, politely let them know you can only help with "${orgName}" matters ` +
    `and suggest they open the Wednesday app and call that organisation's agent directly. ` +
    `When the conversation is ending or the caller says goodbye, always invoke the saveSummary tool with orgId "${orgId}" ` +
    `and a detailed summary covering the topics discussed, questions asked, and information you provided. ` +
    `Greet the caller warmly and introduce yourself as the ${orgName} assistant as soon as the conversation starts.`
  );
}

// Create the AWS Bedrock client
const bedrockClient = new S2SBidirectionalStreamClient({
  requestHandlerConfig: {
    maxConcurrentStreams: 10,
  },
  clientConfig: {
    region: process.env.AWS_REGION || "us-east-1",
    credentials: fromEnv(),
  },
});

const sessionMap = {};

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Root Route
fastify.get("/", async (_request, reply) => {
  reply.send({ message: "Twilio Media Stream Server is running!" });
});

// Initiated by the Wednesday app when a user requests a call with an org.
// Expected query params: orgId, orgName, to (the user's phone number to call)
fastify.all("/outbound-call", async (request, reply) => {
  const query = request.query as Record<string, string>;
  const orgId = query.orgId || "";
  const orgName = query.orgName || "";
  const callTo = query.to;

  if (!orgId || !orgName || !callTo) {
    reply.status(400).send({ error: "orgId and orgName are required" });
    return;
  }

  const params = new URLSearchParams({ orgId, orgName });
  const wssBase = process.env.WSS_BASE_URL || `wss://${request.headers.host}`;
  const streamUrl = `${wssBase}/media-stream?${params.toString().replace(/&/g, '&amp;')}`;

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say language="en-US" voice="Polly.Matthew-Generative">Please wait while we connect you to the ${orgName} assistant.</Say>
                              <Pause length="1"/>
                              <Connect>
                                <Stream url="${streamUrl}" />
                              </Connect>
                          </Response>`;

  const call = await twClient.calls.create({
    from: fromNumber,
    to: callTo,
    twiml: twimlResponse,
  });

  console.log(
    `Outbound call ${call.sid} initiated for org: ${orgName} (${orgId})`,
  );
  reply.send({ callSid: call.sid });
});

// Direct inbound calls are not supported — users must request a call through the Wednesday app.
fastify.all("/incoming-call", async (_request, reply) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say language="en-US" voice="Polly.Matthew-Generative">
                                  Hello there! Thank you for calling Wednesday. However, direct calls are not supported. Please open the Wednesday app,
                                  select the organisation you would like to speak with,
                                  and request a call. We will call you back within seconds. Goodbye.
                              </Say>
                              <Hangup/>
                          </Response>`;
  reply.type("text/xml").send(twimlResponse);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {
    console.log("Client connected");

    //create a session
    const sessionId = randomUUID();
    const session: StreamSession = bedrockClient.createStreamSession(sessionId);
    sessionMap[sessionId] = session; //store the session in the map
    bedrockClient.initiateSession(sessionId); //initiate the session

    const query = req.query as Record<string, string>;
    const orgId = query.orgId || "";
    const orgName = query.orgName || "the organisation";

    let callSid = "";
    let summarySaved = false;
    const transcriptLines: string[] = [];

    // Handle incoming messages from Twilio
    connection.on("message", async (message: string) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case "connected":
            console.log(`connected event ${message}`);
            await session.setupPromptStart();
            break;
          case "start": {
            const systemPrompt = buildSystemPrompt(orgName, orgId);
            await session.setupSystemPrompt(undefined, systemPrompt);
            await session.setupStartAudio();

            session.streamSid = data.streamSid;
            callSid = data.start.callSid; //call sid to update while redirecting it to SIP endpoint
            console.log(
              `Stream started streamSid: ${session.streamSid}, callSid: ${callSid}`,
            );

            //send the audio bytes that say "hello" as to mimick the user greeting to allow model to speak first
            await session.streamAudio(helloAudioBytes);
            break;
          }

          case "media": {
            if (!session.streamSid) break;
            const audioInput = Buffer.from(data.media.payload, "base64");
            const pcmSamples = mulaw.decode(audioInput);
            const audioBuffer = Buffer.from(pcmSamples.buffer);
            await session.streamAudio(audioBuffer);
            break;
          }

          default:
            console.log("Received non-media event:", data.event);
            break;
        }
      } catch (error) {
        console.error("Error parsing message:", error, "Message:", message);
        connection.close();
      }
    });

    // Handle connection close
    connection.on("close", async () => {
      console.log("Client disconnected.");
      if (!summarySaved && transcriptLines.length > 0 && orgId) {
        const summary = `Call transcript (auto-saved on disconnect):\n${transcriptLines.join("\n")}`;
        try {
          await toolProcessor("savesummary", JSON.stringify({ orgId, summary }));
          console.log("Fallback summary saved on disconnect.");
        } catch (e) {
          console.error("Failed to save fallback summary:", e);
        }
      }
    });

    /**
     * Handle all the Nova Sonic events
     */

    // Set up event handlers
    session.onEvent("contentStart", (data) => {
      console.log("contentStart:", data);
      //socket.emit('contentStart', data);
    });

    session.onEvent("textOutput", (data) => {
      console.log("Text output:", data.content.substring(0, 50) + "...");
      if (data.content) transcriptLines.push(`Assistant: ${data.content}`);
    });

    session.onEvent("audioOutput", (data) => {
      //console.log('Audio output received, sending to client');
      //socket.emit('audioOutput', data);
      //send the audio back to twilio
      //console.log('audioOutput')

      // Decode base64 to get the PCM buffer
      const buffer = Buffer.from(data["content"], "base64");
      // Convert to Int16Array (your existing code is correct here)
      const pcmSamples = new Int16Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.length / Int16Array.BYTES_PER_ELEMENT,
      );
      // Encode to mulaw (8-bit)
      const mulawSamples = mulaw.encode(pcmSamples);
      // Convert to base64
      const payload = Buffer.from(mulawSamples).toString("base64");

      const audioResponse = {
        event: "media",
        media: {
          track: "outbound",
          payload,
        },
        streamSid: session.streamSid,
      };

      connection.send(JSON.stringify(audioResponse));
    });

    session.onEvent("error", (data) => {
      console.error("Error in session:", data);
      //socket.emit('error', data);
      //optionally close the connection based on the error
    });

    session.onEvent("toolUse", (data) => {
      console.log("Tool use detected:", data.toolName);
      if (data.toolName?.toLowerCase() === "savesummary") {
        summarySaved = true;
      }
    });

    session.onEvent("toolResult", () => {
      console.log("Tool result received");
    });

    session.onEvent("contentEnd", (data) => {
      console.log("Content end received");
      if (data["stopReason"] == "INTERRUPTED") {
        //since you received more media send a clear message
        const clearMessage = {
          event: "clear",
          streamSid: session.streamSid,
        };
        connection.send(JSON.stringify(clearMessage));
      }
      //socket.emit('contentEnd', data);
    });

    session.onEvent("streamComplete", () => {
      console.log("Stream completed for client:", session.streamSid);
      //socket.emit('streamComplete');
    });
  });
});

const PORT = parseInt(process.env.PORT || "3000", 10);
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on port ${PORT}`);
});
