import { routeAgentRequest, type Schedule } from "agents";

import { unstable_getSchedulePrompt } from "agents/schedule";

import { AIChatAgent } from "agents/ai-chat-agent";
import {
  createDataStreamResponse,
  generateId,
  streamText,
  type StreamTextOnFinishCallback,
} from "ai";
import { openai as openaiClient } from "@ai-sdk/openai";
import { createOpenAI } from "@ai-sdk/openai";
import { processToolCalls } from "./utils";
import { tools, executions } from "./tools";
import { AsyncLocalStorage } from "node:async_hooks";
import puppeteer from "@cloudflare/puppeteer";
import type { Message } from "ai";
import { env } from "cloudflare:workers";

const model = openaiClient("gpt-4.1");
// Cloudflare AI Gateway
const openai = createOpenAI({
apiKey: env.OPENAI_API_KEY,
baseURL: env.GATEWAY_BASE_URL,
});

// we use ALS to expose the agent context to the tools
export const agentContext = new AsyncLocalStorage<DashAgent>();
/**
 * Chat Agent implementation that handles real-time AI chat interactions
 */
export class DashAgent extends AIChatAgent<Env> {
  /**
   * Handles incoming chat messages and manages the response stream
   * @param onFinish - Callback function executed when streaming completes
   */

  // biome-ignore lint/complexity/noBannedTypes: <explanation>
  async onChatMessage(onFinish: StreamTextOnFinishCallback<{}>) {
    return agentContext.run(this, async () => {
      const dataStreamResponse = createDataStreamResponse({
        execute: async (dataStream) => {
          try {
            const processedMessages = await processToolCalls({
              messages: this.messages,
              dataStream,
              tools,
              executions,
            });

            const result = streamText({
              model,
              system: "You are a helpful assistant that can do various tasks.",
              messages: processedMessages,
              tools,
              onFinish,
              onError: (error) => {
                console.error("Error while streaming:", error);
              },
              maxSteps: 10,
            });

            result.mergeIntoDataStream(dataStream);
          } catch (error) {
            console.error("Error processing tool calls:", error);

            // Construct a Message object with correct role type
            const errorMessage: Message = {
              id: `error-${Date.now()}`,
              role: "assistant",
              content: `I encountered an error while trying to perform a task: ${String(error)}. Let's continue our conversation. How can I assist you further?`,
              createdAt: new Date(),
            };

            // Append the error message to the messages so the chat continues gracefully
            this.messages.push(errorMessage);

            // Stream the error message to the user
            await streamText({
              model,
              system: "You are a helpful assistant.",
              messages: this.messages,
              onFinish,
            }).mergeIntoDataStream(dataStream);
          }
        },
      });

      return dataStreamResponse;
    });
  }
  async executeTask(description: string, task: Schedule<string>) {
    await this.saveMessages([
      ...this.messages,
      {
        id: generateId(),
        role: "user",
        content: `Running scheduled task: ${description}`,
        createdAt: new Date(),
      },
    ]);
  }
  /**
   * Browse the web using the Browser Rendering API and extract structured data from pages.
   * @param browserInstance - The browser fetcher instance (from env.MYBROWSER)
   * @param urls - Array of URLs to browse
   */
  async browse(browserInstance: Fetcher, urls: string[], options: { returnHtml?: boolean } = {}): Promise<unknown[]> {
    const responses: unknown[] = [];
    for (const url of urls) {
      try {
        const browser = await puppeteer.launch(browserInstance);
        const page = await browser.newPage();
        await page.goto(url);
        await page.waitForSelector("body");
        if (options.returnHtml) {
          const html = await page.content();
          responses.push(html);
        } else {
          // Extract all links
          const links = await page.$$eval('a', as => as.map(a => a.href));
          responses.push(links);
        }
        await browser.close();
      } catch (error) {
        console.error(`Error browsing URL ${url}:`, error);
        responses.push(`Error browsing URL ${url}: ${error}`);
      }
    }
    return responses;
  }
  /**
   * Public getter for the browser instance (MYBROWSER) from env
   */
  public getBrowserInstance() {
    // @ts-ignore
    return this.env?.MYBROWSER;
  }
}

/**
 * Worker entry point that routes incoming requests to the appropriate handler
 */
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:8788",
  "https://mulls.io",
  "https://agents.mulls.io",
  "https://dash.mulls.io"
];

function withCORS(response: Response, origin: string | null) {
  if (origin && allowedOrigins.includes(origin)) {
    const newResponse = new Response(response.body, response);
    newResponse.headers.set("Access-Control-Allow-Origin", origin);
    newResponse.headers.set("Access-Control-Allow-Credentials", "true");
    newResponse.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    newResponse.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    return newResponse;
  }
  return response;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    // Handle preflight CORS requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin && allowedOrigins.includes(origin) ? origin : "",
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
        }
      });
    }

    try {
      if (url.pathname === "/check-open-ai-key") {
        const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
        return withCORS(Response.json({ success: hasOpenAIKey }), origin);
      }
      if (!process.env.OPENAI_API_KEY) {
        console.error(
          "OPENAI_API_KEY is not set, don't forget to set it locally in .dev.vars, and use `wrangler secret bulk .dev.vars` to upload it to production"
        );
      }
      const response = await routeAgentRequest(request, env);
      if (response) {
        return withCORS(response, origin);
      } else {
        return withCORS(
          new Response(JSON.stringify({ error: "Not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" }
          }),
          origin
        );
      }
    } catch (err) {
      // Always return CORS headers even on error
      return withCORS(
        new Response(JSON.stringify({ error: "Internal Server Error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        }),
        origin
      );
    }
  }
} satisfies ExportedHandler<Env>;
