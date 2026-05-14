import Groq from "groq-sdk";
import { SOURCES, scrapeSource, saveJobs, NormalizedJob } from "@/app/lib/scrape-utils";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Runs EASA, NAPA, and SfAA together (all non-H-Net scraped sources)
export async function GET() {
  try {
    const groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const sources = SOURCES.filter((s) => s.id !== "h-net");
    const results = await Promise.allSettled(
      sources.map((source) => scrapeSource(source, groqClient)),
    );
    const allJobs: NormalizedJob[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        allJobs.push(...result.value);
      } else {
        console.error(`[scrape/sfaa] Source failed:`, result.reason);
      }
    }
    return saveJobs(allJobs);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
