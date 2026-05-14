"use client";

import { useState, useMemo } from "react";
import styles from "./JobsClient.module.scss";
import MultiSelect from "./MultiSelect";

interface Job {
  title: string;
  institution: string;
  location: string | null;
  subfield: string;
  specialization: string | null;
  position_type: string;
  deadline: string | null;
  start_date: string | null;
  url: string;
  source: string;
  sharing_restricted: boolean;
  created_at: string;
}

type SortKey = "recent" | "deadline" | "start_date";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "recent", label: "Most recently added" },
  { value: "deadline", label: "Deadline soonest" },
  { value: "start_date", label: "Start date soonest" },
];

const POSITION_TYPES = [
  { value: "tenure-track", label: "tenure-track" },
  { value: "postdoc", label: "postdoc" },
  { value: "VAP", label: "VAP (Visiting Assistant Professor)" },
  { value: "lecturer", label: "lecturer" },
  { value: "visiting", label: "visiting" },
  { value: "adjunct", label: "adjunct" },
  { value: "other", label: "other" },
];

const SUBFIELDS = [
  "archaeology",
  "cultural",
  "biological",
  "linguistic",
  "applied",
  "historical",
  "medical",
  "environmental",
  "digital",
  "other",
].map((s) => ({ value: s, label: s }));

const REGIONS = [
  "North America",
  "Europe",
  "Latin America",
  "Middle East",
  "Africa",
  "Asia Pacific",
  "Remote/Online",
  "Unknown",
].map((r) => ({ value: r, label: r }));

const REGION_PATTERNS: [string, RegExp][] = [
  ["Remote/Online", /\b(remote|online|virtual)\b/i],
  [
    "North America",
    /\b(usa|united states|u\.s\.a?\.|canada|mexico|ontario|quebec|british columbia|alberta|toronto|montreal|vancouver|austin|boston|chicago|los angeles|new york|nyc|san francisco|seattle|washington\s+d\.?c\.?|alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|west virginia|wisconsin|wyoming)\b/i,
  ],
  [
    "Europe",
    /\b(united kingdom|england|scotland|wales|northern ireland|germany|france|netherlands|belgium|sweden|norway|denmark|finland|estonia|spain|italy|switzerland|austria|ireland|czech republic|poland|portugal|hungary|romania|greece|croatia|serbia|slovakia|slovenia|latvia|lithuania|luxembourg|malta|cyprus|iceland|london|paris|berlin|amsterdam|brussels|vienna|zurich|stockholm|oslo|copenhagen|helsinki|madrid|rome|barcelona|milan|munich|frankfurt|edinburgh|glasgow|cardiff|dublin|warsaw|prague|budapest|bucharest|athens|zagreb|belgrade|\buk\b)\b/i,
  ],
  [
    "Latin America",
    /\b(brazil|brasil|argentina|chile|colombia|peru|venezuela|ecuador|bolivia|paraguay|uruguay|costa rica|guatemala|honduras|panama|dominican republic|puerto rico|cuba|jamaica|belize|nicaragua|el salvador|guyana|suriname|são paulo|sao paulo|rio de janeiro|buenos aires|santiago|bogot[aá]|lima|caracas|quito|la paz|asunci[oó]n|montevideo|san jos[eé])\b/i,
  ],
  [
    "Middle East",
    /\b(israel|turkey|türkiye|iran|iraq|jordan|lebanon|qatar|kuwait|bahrain|oman|yemen|syria|palestine|tel aviv|jerusalem|istanbul|ankara|dubai|abu dhabi|riyadh|tehran|baghdad|amman|beirut|doha|uae|united arab emirates|saudi arabia)\b/i,
  ],
  [
    "Africa",
    /\b(nigeria|south africa|kenya|ghana|ethiopia|tanzania|uganda|mozambique|zambia|zimbabwe|rwanda|cameroon|senegal|ivory coast|côte d.ivoire|cote d.ivoire|morocco|tunisia|algeria|egypt|libya|sudan|somalia|madagascar|angola|namibia|botswana|malawi|mali|burkina faso|niger|chad|democratic republic of congo|republic of congo|gabon|guinea|sierra leone|liberia|togo|benin|johannesburg|cape town|nairobi|accra|lagos|addis ababa|dar es salaam|kampala|kigali|lusaka|harare|dakar|casablanca|tunis|algiers|cairo)\b/i,
  ],
  [
    "Asia Pacific",
    /\b(china|japan|south korea|australia|new zealand|india|singapore|hong kong|taiwan|thailand|indonesia|philippines|vietnam|malaysia|bangladesh|pakistan|nepal|sri lanka|myanmar|cambodia|laos|mongolia|beijing|shanghai|guangzhou|shenzhen|tokyo|osaka|kyoto|seoul|busan|sydney|melbourne|brisbane|perth|auckland|wellington|mumbai|delhi|bengaluru|bangalore|chennai|hyderabad|kolkata|taipei|bangkok|jakarta|manila|ho chi minh|hanoi|kuala lumpur|dhaka|karachi|lahore|kathmandu|colombo|yangon|phnom penh)\b/i,
  ],
];

function getRegion(location: string | null): string {
  if (!location) return "Unknown";
  for (const [region, pattern] of REGION_PATTERNS) {
    if (pattern.test(location)) return region;
  }
  return "Unknown";
}

function parseDateMs(d: string | null): number {
  if (!d) return Infinity;
  const ms = new Date(d).getTime();
  return isNaN(ms) ? Infinity : ms;
}

export default function JobsClient({ jobs }: { jobs: Job[] }) {
  const [query, setQuery] = useState("");
  const [positionFilter, setPositionFilter] = useState<string[]>([]);
  const [subfieldFilter, setSubfieldFilter] = useState<string[]>([]);
  const [specializationFilter, setSpecializationFilter] = useState<string[]>([]);
  const [regionFilter, setRegionFilter] = useState<string[]>([]);
  const [sort, setSort] = useState<SortKey>("recent");

  const specializationOptions = useMemo(() => {
    const vals = new Set(jobs.map((j) => j.specialization).filter(Boolean) as string[]);
    return [...vals].sort().map((s) => ({ value: s, label: s }));
  }, [jobs]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    const matches = jobs.filter((job) => {
      const matchesQuery =
        !q ||
        job.title.toLowerCase().includes(q) ||
        job.institution.toLowerCase().includes(q) ||
        job.subfield.toLowerCase().includes(q) ||
        (job.specialization?.toLowerCase().includes(q) ?? false);

      const matchesPosition =
        positionFilter.length === 0 || positionFilter.includes(job.position_type);

      const matchesSubfield =
        subfieldFilter.length === 0 || subfieldFilter.includes(job.subfield);

      const matchesSpecialization =
        specializationFilter.length === 0 ||
        (job.specialization != null && specializationFilter.includes(job.specialization));

      const matchesRegion =
        regionFilter.length === 0 || regionFilter.includes(getRegion(job.location));

      return matchesQuery && matchesPosition && matchesSubfield && matchesSpecialization && matchesRegion;
    });

    return [...matches].sort((a, b) => {
      if (sort === "deadline") return parseDateMs(a.deadline) - parseDateMs(b.deadline);
      if (sort === "start_date") return parseDateMs(a.start_date) - parseDateMs(b.start_date);
      // "recent" — created_at descending
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [jobs, query, positionFilter, subfieldFilter, specializationFilter, regionFilter, sort]);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>Anthro Jobs</h1>
        <p>Academic anthropology job listings from H-Net, EASA, NAPA, SfAA, and Exa</p>
      </div>

      <div className={styles.controls}>
        <input
          className={styles.search}
          type="search"
          placeholder="Search by title, institution, or subfield…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <MultiSelect
          options={POSITION_TYPES}
          selected={positionFilter}
          onChange={setPositionFilter}
          placeholder="Position type"
        />
        <MultiSelect
          options={SUBFIELDS}
          selected={subfieldFilter}
          onChange={setSubfieldFilter}
          placeholder="Subfield"
        />
        <MultiSelect
          options={specializationOptions}
          selected={specializationFilter}
          onChange={setSpecializationFilter}
          placeholder="Specialization"
        />
        <MultiSelect
          options={REGIONS}
          selected={regionFilter}
          onChange={setRegionFilter}
          placeholder="Region"
        />
        <select
          className={styles.sortSelect}
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
        >
          {SORT_OPTIONS.map(({ value, label }) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      <p className={styles.count}>
        {filtered.length} {filtered.length === 1 ? "listing" : "listings"}
      </p>

      {filtered.length === 0 ? (
        <p className={styles.empty}>No jobs match your search.</p>
      ) : (
        <div className={styles.grid}>
          {filtered.map((job) => (
            <div key={job.url} className={styles.card}>
              <div className={styles.cardHeader}>
                <span className={styles.cardTitle}>{job.title}</span>
                <a
                  href={job.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.link}
                >
                  View posting ↗
                </a>
              </div>

              <div className={styles.institution}>{job.institution}</div>

              <div className={styles.meta}>
                {job.subfield && (
                  <span className={`${styles.badge} ${styles.subfield}`}>
                    {job.subfield}
                  </span>
                )}
                {job.specialization && (
                  <span className={`${styles.badge} ${styles.specialization}`}>
                    {job.specialization}
                  </span>
                )}
                {job.position_type && (
                  <span className={`${styles.badge} ${styles.positionType}`}>
                    {job.position_type}
                  </span>
                )}
              </div>

              {job.sharing_restricted && (
                <span className={`${styles.badge} ${styles.sharingRestricted}`}>
                  ⚠️ Sharing restricted
                </span>
              )}

              {job.location && (
                <div className={styles.location}>📍 {job.location}</div>
              )}
              {job.deadline && (
                <div className={styles.deadline}>Deadline: {job.deadline}</div>
              )}
              {job.start_date && (
                <div className={styles.startDate}>Starts: {job.start_date}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
