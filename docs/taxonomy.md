# Taxonomy and the replay test

## Importing a taxonomy

The AI model picks tags, document types, and projects only from the lists in
the library. Stewards edit them under **Admin → Taxonomy**. A whole list,
such as an existing tagging system with its clusters, comes in with one
command:

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
  "documentTypes": ["Study", "Report"],
  "projects": ["Climate Lab"]
}
```

A tag's description tells the model what the tag covers. On its first start,
the worker adds the default document types (Study, Report, Article, Policy
paper, Funder guideline, Book, Presentation, Website, Other) when there are
none.

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
      "expected": { "tags": ["Heat", "Municipalities"], "documentType": "Study", "project": null }
    },
    { "url": "https://example.org/report", "expected": { "tags": ["Funding"] } }
  ]
}
```

Files are relative to the test-set file. Leave out `documentType` or
`project` to skip that check. The summary reports tag recall and precision,
the accuracy of document types and projects, and how often the model set a
project where none was expected.
