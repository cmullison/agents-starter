/**
 * Tool definitions for the AI chat agent
 * Tools can either require human confirmation or execute automatically
 */
import { tool } from "ai";
import { z } from "zod";
// biome-ignore lint/style/useImportType: <explanation>
import { Browser, Page } from "@cloudflare/puppeteer";

import { agentContext } from "./server";
import {
  unstable_getSchedulePrompt,
  unstable_scheduleSchema,
} from "agents/schedule";

/**
 * Weather information tool that requires human confirmation
 * When invoked, this will present a confirmation dialog to the user
 * The actual implementation is in the executions object below
 */
const getWeatherInformation = tool({
  description: "show the weather in a given city to the user",
  parameters: z.object({ city: z.string() }),
  // Omitting execute function makes this tool require human confirmation
});

/**
 * Local time tool that executes automatically
 * Since it includes an execute function, it will run without user confirmation
 * This is suitable for low-risk operations that don't need oversight
 */
const getLocalTime = tool({
  description: "get the local time for a specified location",
  parameters: z.object({ location: z.string() }),
  execute: async ({ location }) => {
    console.log(`Getting local time for ${location}`);
    return "10am";
  },
});

const scheduleTask = tool({
  description: "A tool to schedule a task to be executed at a later time",
  parameters: unstable_scheduleSchema,
  execute: async ({ when, description }) => {
    // we can now read the agent context from the ALS store
    const agent = agentContext.getStore();
    if (!agent) {
      throw new Error("No agent found");
    }
    function throwError(msg: string): string {
      throw new Error(msg);
    }
    if (when.type === "no-schedule") {
      return "Not a valid schedule input";
    }
    const input =
      when.type === "scheduled"
        ? when.date // scheduled
        : when.type === "delayed"
          ? when.delayInSeconds // delayed
          : when.type === "cron"
            ? when.cron // cron
            : throwError("not a valid schedule input");
    try {
      agent.schedule(input!, "executeTask", description);
    } catch (error) {
      console.error("error scheduling task", error);
      return `Error scheduling task: ${error}`;
    }
    return `Task scheduled for type "${when.type}" : ${input}`;
  },
});

/**
 * Tool to list all scheduled tasks
 * This executes automatically without requiring human confirmation
 */
const getScheduledTasks = tool({
  description: "List all tasks that have been scheduled",
  parameters: z.object({}),
  execute: async () => {
    const agent = agentContext.getStore();
    if (!agent) {
      throw new Error("No agent found");
    }
    try {
      const tasks = agent.getSchedules();
      if (!tasks || tasks.length === 0) {
        return "No scheduled tasks found.";
      }
      return tasks;
    } catch (error) {
      console.error("Error listing scheduled tasks", error);
      return `Error listing scheduled tasks: ${error}`;
    }
  },
});

/**
 * Tool to cancel a scheduled task by its ID
 * This executes automatically without requiring human confirmation
 */
const cancelScheduledTask = tool({
  description: "Cancel a scheduled task using its ID",
  parameters: z.object({
    taskId: z.string().describe("The ID of the task to cancel"),
  }),
  execute: async ({ taskId }) => {
    const agent = agentContext.getStore();
    if (!agent) {
      throw new Error("No agent found");
    }
    try {
      await agent.cancelSchedule(taskId);
      return `Task ${taskId} has been successfully canceled.`;
    } catch (error) {
      console.error("Error canceling scheduled task", error);
      return `Error canceling task ${taskId}: ${error}`;
    }
  },
});

const findGolfCourseWebsite = tool({
  description: "Find the official website URL of a golf course by searching Google",
  parameters: z.object({ courseName: z.string() }),
  execute: async ({ courseName }) => {
    const agent = agentContext.getStore();
    if (!agent || typeof agent.browse !== "function") {
      throw new Error("No agent with a browse method found");
    }
    try {
      const query = encodeURIComponent(`${courseName} golf course official website`);
      const googleSearchUrl = `https://www.google.com/search?q=${query}`;

      // Use optional chaining here as linter suggests
      const browserInstance = agent.getBrowserInstance?.();
      if (!browserInstance) {
        throw new Error("Browser instance (MYBROWSER) not found in agent environment");
      }

      const searchResults = await agent.browse(browserInstance, [googleSearchUrl], { returnHtml: true });
      const htmlContent = searchResults[0] as string | undefined;
      if (!htmlContent) {
        return "No content returned from browsing Google search results.";
      }

      // Extract first URL using regex
      const urlMatch = htmlContent.match(/<a href="\/url\?q=(https?:\/\/[^&"]+)/);
      if (urlMatch?.[1]) {
        return urlMatch[1];
      }
      return "No golf course website URL found in search results.";
    } catch (error) {
      console.error("Error finding golf course website", error);
      return `Error finding golf course website: ${error}`;
    }
  },
});

const findTeeTimes = tool({
  description: "Find the tee times page URL for a golf course, optionally for a specific date",
  parameters: z.object({
    courseName: z.string(),
    date: z.string().optional(), // ISO date string, e.g. "2024-06-01"
  }),
  execute: async ({ courseName, date }) => {
    const agent = agentContext.getStore();
    if (!agent || typeof agent.browse !== "function") {
      throw new Error("No agent with a browse method found");
    }

    function extractCourseUrl(html: string): string | null {
      const match = html.match(/<a href="\/url\?q=(https?:\/\/[^&"]+)/);
      return match ? match[1] : null;
    }

    try {
      console.log(`[findTeeTimes] Starting search for course: ${courseName}, date: ${date}`);

      const query = encodeURIComponent(`${courseName} golf course official website`);
      const googleSearchUrl = `https://www.google.com/search?q=${query}`;
      console.log(`[findTeeTimes] Google search URL: ${googleSearchUrl}`);

      const browserInstance = agent.getBrowserInstance?.();
      if (!browserInstance) {
        throw new Error("Browser instance not found in agent environment");
      }

      const searchResults = await agent.browse(browserInstance, [googleSearchUrl], { returnHtml: true });
      const htmlContent = searchResults[0] as string | undefined;
      if (!htmlContent) {
        console.log("[findTeeTimes] No content returned from browsing Google search results.");
        return "No content returned from browsing Google search results.";
      }
      console.log("[findTeeTimes] Google search results received.");

      const courseUrl = extractCourseUrl(htmlContent);
      if (!courseUrl) {
        console.log("[findTeeTimes] No golf course website URL found in search results.");
        return "No golf course website URL found in search results.";
      }
      console.log(`[findTeeTimes] Extracted course URL: ${courseUrl}`);

      const browser = agent.getBrowserInstance?.() as unknown as Browser;
      if (!browser) {
        throw new Error("Browser instance (Puppeteer) not found in agent environment");
      }

      let page: Page | null = null;
      try {
        page = await browser.newPage();
        console.log("[findTeeTimes] New page opened, navigating to course URL...");
        await page.goto(courseUrl, { waitUntil: "domcontentloaded" });
        console.log("[findTeeTimes] Page loaded.");

        const linkSelectors = ["a", "button"];
        let teeTimesHref: string | null = null;

        for (const selector of linkSelectors) {
          console.log(`[findTeeTimes] Waiting for selector: ${selector}`);
          try {
            await page.waitForSelector(selector, { timeout: 5000, visible: true });
          } catch {
            console.log(`[findTeeTimes] No elements found for selector: ${selector}`);
            continue;
          }

          teeTimesHref = await page.evaluate((sel) => {
            const elements = Array.from(document.querySelectorAll(sel));
            const regex = /tee times|book(ing)? tee times|reserve/i;
            for (const el of elements) {
              if (regex.test(el.textContent || "")) {
                if (el.tagName.toLowerCase() === "a") {
                  return (el as HTMLAnchorElement).href;
                // biome-ignore lint/style/noUselessElse: <explanation>
                } else if (el.tagName.toLowerCase() === "button") {
                  const linkInside = el.querySelector("a");
                  if (linkInside) return (linkInside as HTMLAnchorElement).href;
                  return null;
                }
              }
            }
            return null;
          }, selector);

          console.log(`[findTeeTimes] teeTimesHref found for selector ${selector}: ${teeTimesHref}`);

          if (teeTimesHref) break;
        }

        if (!teeTimesHref) {
          console.log("[findTeeTimes] No href found, attempting to click button/link with matching text...");
          const clicked = await page.evaluate(() => {
            const regex = /tee times|book(ing)? tee times|reserve/i;
            const elements = Array.from(document.querySelectorAll("a,button"));
            for (const el of elements) {
              if (regex.test(el.textContent || "")) {
                (el as HTMLElement).click();
                return true;
              }
            }
            return false;
          });
          console.log(`[findTeeTimes] Clicked: ${clicked}`);
          if (!clicked) {
            return "No tee times link or button found on the landing page.";
          }
          console.log("[findTeeTimes] Waiting for navigation after click...");
          await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 });
          console.log("[findTeeTimes] Navigation after click complete.");
        } else {
          console.log(`[findTeeTimes] Navigating directly to tee times href: ${teeTimesHref}`);
          await page.goto(teeTimesHref, { waitUntil: "domcontentloaded" });
          console.log("[findTeeTimes] Navigation to tee times href complete.");
        }

        if (date) {
          console.log(`[findTeeTimes] Date provided: ${date}, attempting to set date...`);
          const dateSelectors = [
            'input[type="date"]',
            'input[name*="date"]',
            'input[id*="date"]',
            '.datepicker',
            '.date-picker',
            '[aria-label*="date"]',
          ];

          let dateSet = false;
          for (const sel of dateSelectors) {
            try {
              console.log(`[findTeeTimes] Trying date selector: ${sel}`);
              await page.waitForSelector(sel, { timeout: 3000, visible: true });
              const isInput = await page.$eval(sel, el => el.tagName.toLowerCase() === "input");
              if (isInput) {
                await page.$eval(sel, (el, value) => {
                  (el as HTMLInputElement).value = value;
                  el.dispatchEvent(new Event("input", { bubbles: true }));
                  el.dispatchEvent(new Event("change", { bubbles: true }));
                }, date);
                console.log(`[findTeeTimes] Date set using selector: ${sel}`);
                dateSet = true;
                break;
              }
            } catch (e) {
              console.log(`[findTeeTimes] Failed to set date with selector ${sel}: ${e}`);
              // biome-ignore lint/correctness/noUnnecessaryContinue: <explanation>
              continue;
            }
          }

          if (dateSet) {
            console.log("[findTeeTimes] Waiting 2 seconds after setting date...");
            await new Promise(resolve => setTimeout(resolve, 2000));
          } else {
            console.log("[findTeeTimes] Could not set date on page.");
          }
        }

        const finalUrl = page.url();
        console.log(`[findTeeTimes] Final URL: ${finalUrl}`);
        return finalUrl;

      } catch (error) {
        console.error("[findTeeTimes] Error finding tee times", error);
        return `Error finding tee times: ${error}`;
      } finally {
        if (page) {
          await page.close();
          console.log("[findTeeTimes] Page closed.");
        }
      }
    } catch (error) {
      console.error("[findTeeTimes] Unexpected error", error);
      return `Unexpected error: ${error}`;
    }
  },
});
/**
 * Export all available tools
 * These will be provided to the AI model to describe available capabilities
 */
export const tools = {
  getWeatherInformation,
  getLocalTime,
  scheduleTask,
  getScheduledTasks,
  cancelScheduledTask,
  browse: tool({
    description: "Browse the web and extract structured data.",
    parameters: z.object({ urls: z.array(z.string()) }),
    execute: async ({ urls }) => {
      const agent = agentContext.getStore();
      if (!agent || typeof agent.browse !== 'function') {
        throw new Error("No agent with a browse method found");
      }
      try {
        const browserInstance = agent.getBrowserInstance?.();
        if (!browserInstance) {
          throw new Error("Browser instance (MYBROWSER) not found in agent environment");
        }
        const result = await agent.browse(browserInstance, urls);
        return result;
      } catch (error) {
        console.error("Error during browsing", error);
        return `Error during browsing: ${error}`;
      }
    },
  }),
  findGolfCourseWebsite,
  findTeeTimes,
};

/**
 * Implementation of confirmation-required tools
 * This object contains the actual logic for tools that need human approval
 * Each function here corresponds to a tool above that doesn't have an execute function
 */
export const executions = {
  getWeatherInformation: async ({ city }: { city: string }) => {
    console.log(`Getting weather information for ${city}`);
    return `The weather in ${city} is sunny`;
  },
};
