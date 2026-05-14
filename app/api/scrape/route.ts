import Groq from "groq-sdk";
import { SOURCES, scrapeSource, scrapeExa, saveJobs, NormalizedJob } from "@/app/lib/scrape-utils";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const sourceFilter = searchParams.get("source");

    const groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const tasks =
      sourceFilter === "exa"
        ? [scrapeExa(groqClient)]
        : [...SOURCES.map((source) => scrapeSource(source, groqClient)), scrapeExa(groqClient)];

    const results = await Promise.allSettled(tasks);

    const allJobs: NormalizedJob[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        allJobs.push(...result.value);
      } else {
        console.error(`[scrape] Source failed:`, result.reason);
      }
    }

    return saveJobs(allJobs);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
