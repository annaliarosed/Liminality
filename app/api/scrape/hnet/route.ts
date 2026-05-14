import Groq from "groq-sdk";
import { scrapeHNet, saveJobs } from "@/app/lib/scrape-utils";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  console.log("[hnet] route started");
  try {
    const groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const jobs = await scrapeHNet(groqClient);
    return saveJobs(jobs);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
