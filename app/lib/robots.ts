const USER_AGENT = "anthro-jobs-aggregator";

interface RobotsGroup {
  agents: string[];
  allow: string[];
  disallow: string[];
}

function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.split("#")[0].trim();
    const sep = line.indexOf(":");
    if (sep === -1) {
      if (!line && current) {
        groups.push(current);
        current = null;
      }
      continue;
    }
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (key === "user-agent") {
      if (!current || current.allow.length || current.disallow.length) {
        if (current) groups.push(current);
        current = { agents: [], allow: [], disallow: [] };
      }
      current.agents.push(value.toLowerCase());
    } else if (key === "disallow" && current && value) {
      current.disallow.push(value);
    } else if (key === "allow" && current && value) {
      current.allow.push(value);
    }
  }
  if (current) groups.push(current);
  return groups;
}

function patternMatches(pattern: string, urlPath: string): boolean {
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+?^{}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\$$/, "$"),
  );
  return regex.test(urlPath);
}

function checkAllowed(groups: RobotsGroup[], urlPath: string): boolean {
  const specific = groups.find((g) =>
    g.agents.includes(USER_AGENT.toLowerCase()),
  );
  const wildcard = groups.find((g) => g.agents.includes("*"));
  const group = specific ?? wildcard;
  if (!group) return true;

  let bestAllow = "";
  let bestDisallow = "";

  for (const p of group.allow) {
    if (patternMatches(p, urlPath) && p.length > bestAllow.length)
      bestAllow = p;
  }
  for (const p of group.disallow) {
    if (patternMatches(p, urlPath) && p.length > bestDisallow.length)
      bestDisallow = p;
  }

  if (!bestDisallow) return true;
  return bestAllow.length >= bestDisallow.length;
}

export async function isAllowedByRobots(url: string): Promise<boolean> {
  try {
    const { protocol, host, pathname, search } = new URL(url);
    const res = await fetch(`${protocol}//${host}/robots.txt`, {
      headers: {
        "User-Agent": `Mozilla/5.0 (compatible; ${USER_AGENT}/1.0)`,
      },
    });
    if (!res.ok) return true;
    return checkAllowed(parseRobots(await res.text()), pathname + search);
  } catch {
    return true;
  }
}
