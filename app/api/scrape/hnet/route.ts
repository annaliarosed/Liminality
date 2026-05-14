import Groq from "groq-sdk";
import { SOURCES, scrapeSource, saveJobs } from "@/app/lib/scrape-utils";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const source = SOURCES.find((s) => s.id === "h-net")!;
    const jobs = await scrapeSource(source, groqClient);
    return saveJobs(jobs);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
