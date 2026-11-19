ALTER TABLE "note" DROP CONSTRAINT "note_project_id_project_id_fk";--> statement-breakpoint
ALTER TABLE "note" DROP COLUMN "project_id";--> statement-breakpoint
DROP TABLE "project";--> statement-breakpoint
ALTER TABLE "document_type" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Libraries that have document types already: the defaults get their
-- descriptions, and the new defaults are added. A new library has none yet;
-- the worker adds all defaults at its first start (DEFAULT_DOCUMENT_TYPES).
UPDATE "document_type" SET "description" = v.description
FROM (VALUES
	('Study', 'Research with its own data or analysis, such as a survey, an evaluation, or an academic paper'),
	('Report', 'An organization''s account of its work or findings, such as an annual or a situation report'),
	('Article', 'A news, magazine, or blog article'),
	('Policy paper', 'A position paper, strategy, or proposal on policy'),
	('Funder guideline', 'A funder''s call, program guidelines, or application rules'),
	('Book', 'A book or a chapter of one'),
	('Presentation', 'Slides or the handout of a talk'),
	('Website', 'A web page that is not an article, such as an organization''s or a program''s page'),
	('Other', 'A source that fits none of the other types')
) AS v(name, description)
WHERE "document_type"."name" = v.name AND "document_type"."description" = '';--> statement-breakpoint
INSERT INTO "document_type" ("name", "description")
SELECT v.name, v.description
FROM (VALUES
	('Podcast', 'A podcast episode, or its page with show notes'),
	('Transcript', 'The written record of something spoken, such as a talk, an interview, a hearing, or a podcast episode'),
	('Social media post', 'A post or thread on a social network')
) AS v(name, description)
WHERE EXISTS (SELECT 1 FROM "document_type")
ON CONFLICT DO NOTHING;
