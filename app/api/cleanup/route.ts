import { createClient } from "@supabase/supabase-js";
import { isDeadlineExpired, isStartYearPassed } from "@/app/lib/deadline";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_KEY!,
    );

    const { data, error } = await supabase
      .from("jobs")
      .select("url, title, deadline, start_date");

    if (error) throw new Error(`Fetch failed: ${error.message}`);

    const expiredUrls = (data ?? [])
      .filter(
        (job) =>
          isDeadlineExpired(job.deadline, { log: console.log, url: job.url }) ||
          isStartYearPassed(job.start_date, { log: console.log, url: job.url }),
      )
      .map((job) => job.url);

    if (expiredUrls.length === 0) {
      return Response.json({ deleted: 0 });
    }

    const { error: deleteError } = await supabase
      .from("jobs")
      .delete()
      .in("url", expiredUrls);

    if (deleteError) throw new Error(`Delete failed: ${deleteError.message}`);

    console.log(`[cleanup] Deleted ${expiredUrls.length} expired jobs`);
    return Response.json({ deleted: expiredUrls.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
