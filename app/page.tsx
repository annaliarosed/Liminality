import { createClient } from "@supabase/supabase-js";
import JobsClient from "./components/JobsClient";
import { isDeadlineExpired, isStartYearPassed } from "./lib/deadline";

export const dynamic = "force-dynamic";

async function getJobs() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!,
  );

  let { data, error } = await supabase
    .from("jobs")
    .select("title, institution, location, subfield, specialization, position_type, deadline, start_date, url, source, sharing_restricted, created_at")
    .order("created_at", { ascending: false });

  if (error?.message?.includes("start_date") || error?.message?.includes("specialization")) {
    // Column not yet migrated — fall back without new columns
    const fallback = await supabase
      .from("jobs")
      .select("title, institution, location, subfield, position_type, deadline, url, source, sharing_restricted, created_at")
      .order("created_at", { ascending: false });
    if (fallback.error) throw new Error(`Failed to fetch jobs: ${fallback.error.message}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (fallback.data ?? []) as any[];
  }

  if (error) throw new Error(`Failed to fetch jobs: ${error.message}`);
  return (data ?? []).filter(
    (job) => !isDeadlineExpired(job.deadline) && !isStartYearPassed(job.start_date),
  );
}

export default async function Home() {
  const jobs = await getJobs();
  return <JobsClient jobs={jobs} />;
}
