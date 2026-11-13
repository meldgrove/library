import { eq, sql } from "drizzle-orm";
import { getDb, getPool } from "@/lib/db/client";
import { documentType, note, person, project, tag } from "@/lib/db/schema";
import { getStorage } from "@/lib/storage";
import { createFakeModel } from "@/lib/library/draft";
import { noteFormSchema } from "@/lib/library/note-input";
import { processNext } from "@/lib/library/pipeline";
import { checkNote, saveNote } from "@/lib/library/review";
import { submitFile } from "@/lib/library/submissions";
import { ensureDefaultDocumentTypes, importTaxonomy } from "@/lib/library/taxonomy";

/*
 * Fills the development database with example notes, to try the interface:
 *   npm run directory:sync && npm run dev:seed
 * Development only. The sources are made up; every name is an example.
 * Needs the development Keycloak's people (erika, adam) in the database.
 */

const TAXONOMY = {
  clusters: [
    { name: "Topics", tags: ["Climate", "Democracy", "Education", "Health", "Volunteering"] },
    { name: "How we work", tags: ["Funding", "Impact", "Digital", "Governance"] },
  ],
  documentTypes: [],
  projects: ["Neighbourhood Climate Fund", "Youth Councils"],
};

interface DemoSource {
  owner: "erika" | "adam";
  title: string;
  core: string;
  keyPoints: string[];
  quote: string;
  location: string;
  citation: string;
  type: string;
  project?: string;
  tags: string[];
  visibility: "all" | "team";
  checked?: boolean;
  /** Left as a draft for its owner to review. */
  draft?: boolean;
}

const SOURCES: DemoSource[] = [
  {
    owner: "erika",
    title: "Keeping Volunteers: Retention in Small Nonprofits",
    core: "Most volunteers who leave small nonprofits do so in their first six months. Clear first tasks and a named contact person halve early drop-out.",
    keyPoints: ["Survey of 412 organizations with fewer than 20 staff", "38 percent of new volunteers leave within six months", "A named contact person cuts early drop-out by half", "Recognition matters more than training budgets"],
    quote: "The first month decides whether a volunteer stays for years.",
    location: "p. 7",
    citation: "Example Institute for Civil Society (2026). Keeping Volunteers. Berlin.",
    type: "Study",
    tags: ["Volunteering", "Governance"],
    visibility: "all",
    checked: true,
  },
  {
    owner: "adam",
    title: "Digital Skills in Community Organizations 2026",
    core: "Community organizations use more digital tools than five years ago, but few have a budget for them. Shared tools across networks are the cheapest way to catch up.",
    keyPoints: ["Two thirds use a shared cloud drive", "Only 14 percent have a budget line for software", "Networks that share tools spend 40 percent less per member", "Data protection is the most named worry"],
    quote: "Digital work is still paid for out of goodwill.",
    location: "p. 3",
    citation: "Northfield Foundation (2026). Digital Skills in Community Organizations. Annual report.",
    type: "Report",
    tags: ["Digital", "Funding"],
    visibility: "all",
  },
  {
    owner: "erika",
    title: "Heat Action Plans in Small Towns",
    core: "Small towns rarely have heat action plans. Staff and funding for implementation are missing, while planning is often funded.",
    keyPoints: ["42 percent of small towns surveyed have no heat action plan", "On average half a position works on climate adaptation", "Funding programs cover planning, not implementation"],
    quote: "Without staff, every heat plan stays on paper.",
    location: "p. 12",
    citation: "Example Institute (2026). Heat Protection in Small Towns. Berlin.",
    type: "Study",
    project: "Neighbourhood Climate Fund",
    tags: ["Climate", "Health"],
    visibility: "all",
    checked: true,
  },
  {
    owner: "adam",
    title: "Funding Guidelines: Local Democracy Program 2027",
    core: "The program funds projects that bring residents into local decisions, with up to 50,000 euros over two years. Applications open in March 2027.",
    keyPoints: ["Up to 50,000 euros per project over two years", "Own contribution of 10 percent, volunteer hours count", "Applications from 1 March to 30 April 2027"],
    quote: "Projects must reach people who do not usually take part.",
    location: "section 2",
    citation: "Northfield Foundation (2026). Local Democracy Program: Funding Guidelines 2027.",
    type: "Funder guideline",
    project: "Youth Councils",
    tags: ["Democracy", "Funding"],
    visibility: "team",
  },
  {
    owner: "erika",
    title: "Measuring Impact Without a Data Team",
    core: "Small organizations can measure impact with three questions asked the same way every time. Consistency matters more than sophisticated methods.",
    keyPoints: ["Ask the same three questions at the start and at the end", "A spreadsheet is enough for teams under 30 people", "Report changes, not activities"],
    quote: "Count what changed, not what you did.",
    location: "p. 2",
    citation: "Sample, Sam (2026). Measuring Impact Without a Data Team. Nonprofit Practice Review 4 (2).",
    type: "Article",
    tags: ["Impact", "Digital"],
    visibility: "all",
  },
  {
    owner: "adam",
    title: "Youth Participation in Local Decisions",
    core: "Youth councils work when their proposals get a formal answer from the council within three months. Without that answer, participation drops sharply in the second year.",
    keyPoints: ["Study of 60 youth councils over four years", "A formal answer within three months keeps members engaged", "Participation halves in year two without it", "Schools are the best place to recruit"],
    quote: "Young people stay when someone answers them.",
    location: "p. 21",
    citation: "Example Centre for Participation (2025). Youth Councils That Last. Policy paper.",
    type: "Policy paper",
    project: "Youth Councils",
    tags: ["Democracy", "Education"],
    visibility: "all",
  },
  {
    owner: "erika",
    title: "Community Health Workers in Rural Areas",
    core: "Community health workers reach people that clinics do not. The pilots that lasted had stable funding for at least three years.",
    keyPoints: ["Five pilots in rural districts compared", "Visits doubled the use of preventive check-ups", "Pilots with one-year funding all ended"],
    quote: "Trust takes longer to build than a funding period lasts.",
    location: "p. 9",
    citation: "Example Health Network (2026). Community Health Workers in Rural Areas.",
    type: "Report",
    tags: ["Health", "Funding"],
    visibility: "all",
    draft: true,
  },
];

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("The demo data is for development only.");
  const db = getDb();
  const storage = getStorage();
  const people = await db.select().from(person).where(sql`lower(${person.workEmail}) in ('erika@example.test', 'adam@example.test')`);
  const byName = (name: DemoSource["owner"]) => people.find((p) => p.workEmail?.toLowerCase().startsWith(name));
  if (!byName("erika") || !byName("adam")) throw new Error("Run `npm run directory:sync` first: Erika and Adam must be in the database.");

  await ensureDefaultDocumentTypes(db);
  await importTaxonomy(db, TAXONOMY);
  const tags = await db.select().from(tag);
  const types = await db.select().from(documentType);
  const projects = await db.select().from(project);
  const model = createFakeModel();
  let added = 0;

  for (const demo of SOURCES) {
    const [existing] = await db.select({ id: note.id }).from(note).where(eq(note.title, demo.title));
    if (existing) continue;
    const owner = byName(demo.owner)!;
    const text = [demo.title, demo.core, ...demo.keyPoints, `"${demo.quote}"`, demo.citation].join("\n\n").repeat(3);
    await submitFile(db, storage, { submitterId: owner.id, channel: "web", reason: "Useful for our work", fileName: `${demo.title}.txt`, bytes: new TextEncoder().encode(text) }, 10 * 1_048_576);
    const outcome = await processNext({ db, storage, model, ocr: { languages: "eng" }, maxBytes: 10 * 1_048_576, dailyDraftLimit: 1_000 });
    if (outcome !== "drafted") throw new Error(`"${demo.title}" was not drafted: ${outcome}`);
    if (demo.draft) {
      added += 1;
      continue;
    }
    const [drafted] = await db.select().from(note).orderBy(sql`${note.number} desc`).limit(1);
    const input = noteFormSchema.parse({
      intent: "publish",
      title: demo.title,
      core: demo.core,
      keyPoints: demo.keyPoints.join("\n"),
      quotes: `${demo.quote} | ${demo.location}`,
      citation: demo.citation,
      language: "en",
      documentTypeId: types.find((t) => t.name === demo.type)?.id ?? "",
      projectId: projects.find((p) => p.name === demo.project)?.id ?? "",
      tagIds: tags.filter((t) => demo.tags.includes(t.name)).map((t) => t.id),
      newTags: "",
      visibility: demo.visibility,
    });
    await saveNote(db, { personId: owner.id, isAdmin: owner.isAdmin }, drafted!.id, input);
    const steward = people.find((p) => p.isAdmin);
    if (demo.checked && steward) await checkNote(db, { personId: steward.id, isAdmin: true }, drafted!.id);
    added += 1;
  }
  console.log(`Added ${added} example notes.`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
