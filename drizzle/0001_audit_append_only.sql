-- The audit log is append-only, and people and teams are never deleted
-- (people who leave lose access; teams are deactivated). Notes, sources, and
-- their uploads can be deleted for copyright or privacy requests.

CREATE FUNCTION library_forbid_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The library never deletes rows from %', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION library_forbid_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_event_no_update BEFORE UPDATE ON audit_event FOR EACH ROW EXECUTE FUNCTION library_forbid_update();
--> statement-breakpoint
CREATE TRIGGER audit_event_no_delete BEFORE DELETE ON audit_event FOR EACH ROW EXECUTE FUNCTION library_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER person_no_delete BEFORE DELETE ON person FOR EACH ROW EXECUTE FUNCTION library_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER team_no_delete BEFORE DELETE ON team FOR EACH ROW EXECUTE FUNCTION library_forbid_delete();
