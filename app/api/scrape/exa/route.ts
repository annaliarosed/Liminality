import Groq from "groq-sdk";
import { scrapeExa, saveJobs } from "@/app/lib/scrape-utils";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const jobs = await scrapeExa(groqClient);
    return saveJobs(jobs);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
