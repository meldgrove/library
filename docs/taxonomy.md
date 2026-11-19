# Taxonomy and the replay test

## The lists

The AI model picks from lists kept in the library, and uploaders correct its
picks before they publish. Maintainers and admins edit the lists under
**Maintenance → Taxonomy**.

| List | Per note | What it says |
|---|---|---|
| Tags | 2 to 5 | What the source is about, in detail |
| Topic areas | none or one | The area the source is mainly about |
| Document types | none or one | What kind of source it is |

Clusters group tags: in the review form, in the tags people follow, in the
weekly digest (by the cluster of each note's first tag), and in the list the
AI model gets. Notes carry tags, not clusters, so deleting a cluster only
takes its tags out of it.

Each tag, topic area, and document type can have a description of one line
that tells the AI model what it covers. A renamed entry keeps its notes. An
entry that is no longer needed is deactivated: it stays on its notes but is
no longer offered. The library can be filtered by tag, topic area, document
type, and team (the owner's team).

On its first start, the worker adds default document types and topic areas,
each with a description, to a list that is still empty. Maintainers then
rename, describe, deactivate, or add entries like any other. A library that
imports its own document types or topic areas before that start gets only
its own.

- **Document types:** Study, Report, Article, Policy paper, Funder guideline,
  Book, Presentation, Website, Podcast, Transcript, Social media post, and
  Other.
- **Topic areas:** Agriculture, Agroforestry, Aging, Arts & culture, Building
  & housing, Climate action & nature, Community & social cohesion, Community
  catering, Cross-cutting, Democracy, Economy & industry, Education, Energy &
  utilities, Europe, Family & children, Finance, Food & nutrition, Health,
  Justice & law, Media & communication, Migration & refugees, Mobility &
  logistics, Nursing & care, Other, Paludiculture, Politics, Public
  administration & civil service, Public safety, Religion & belief, Research,
  Social affairs & inclusion, Sports, Technology & digital transformation,
  Tourism, Work & skilled labor, and Youth.

The descriptions are in `src/lib/library/taxonomy.ts`.

## Importing a taxonomy

A whole list, such as an existing tagging system with its clusters, comes in
with one command:

```sh
npm run taxonomy:import -- taxonomy.json
# in the container:
docker compose exec -T worker node dist/taxonomy-import.mjs /path/taxonomy.json
```

The import adds what is missing and changes nothing else, so it can run again
after the file grows.

```json
{
  "clusters": [
    {
      "name": "Climate",
      "tags": ["Adaptation", { "name": "Heat", "description": "Heat waves and heat protection plans" }]
    }
  ],
  "topicAreas": [{ "name": "Climate and environment", "description": "Climate change, adaptation, and nature" }, "Civil society"],
  "documentTypes": ["Study", { "name": "Toolkit", "description": "Templates and step-by-step guides for practitioners" }]
}
```

Tags, topic areas, and document types are a name, or a name with a
description.

## Replay test

Before people start uploading, or after changing the AI model or the
taxonomy, draft 20 to 30 items with known answers and compare. The replay
uses the configured AI model and today's taxonomy, and writes nothing to the
database.

```sh
npm run replay -- test-set.json
# in the container:
docker compose exec -T worker node dist/replay.mjs /path/test-set.json
```

```json
{
  "items": [
    {
      "file": "items/heat-study.pdf",
      "reason": "Numbers on heat plans",
      "expected": { "tags": ["Heat", "Municipalities"], "documentType": "Study", "topicArea": "Climate and environment" }
    },
    { "url": "https://example.org/report", "expected": { "tags": ["Funding"] } }
  ]
}
```

Files are relative to the test-set file. Leave out `documentType` or
`topicArea` to skip that check, or set `topicArea` to `null` for a source
without one. The summary reports tag recall and precision, the accuracy of
document types and topic areas, and how often the model set a topic area
where `null` was expected.
