-- Enforce version immutability in the database, not only in application code.
-- A version's content is written once while status = 'PROCESSING'. Afterwards only the
-- status transitions VALIDATED -> PUBLISHED and publication metadata may change, and a
-- published version can only be deleted by an explicit purge (SET LOCAL okf.allow_purge = 'on').

CREATE OR REPLACE FUNCTION okf_guard_dataset_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'PUBLISHED' AND coalesce(current_setting('okf.allow_purge', true), '') <> 'on' THEN
      RAISE EXCEPTION 'published dataset version % is immutable and cannot be deleted', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'PROCESSING' THEN
    RETURN NEW;
  END IF;

  IF (NEW.dataset_id, NEW.organization_id, NEW.number, NEW.source_type, NEW.source_url,
      NEW.original_filename, NEW.archive_key, NEW.archive_size, NEW.archive_sha256, NEW.format,
      NEW.scan_status, NEW.okf_version, NEW.concept_count, NEW.file_count, NEW.total_bytes,
      NEW.valid, NEW.error_count, NEW.warning_count, NEW.info_count, NEW.quality_score,
      NEW.profile, NEW.field_schema, NEW.metadata, NEW.failure, NEW.created_by, NEW.created_at,
      NEW.processed_at)
     IS DISTINCT FROM
     (OLD.dataset_id, OLD.organization_id, OLD.number, OLD.source_type, OLD.source_url,
      OLD.original_filename, OLD.archive_key, OLD.archive_size, OLD.archive_sha256, OLD.format,
      OLD.scan_status, OLD.okf_version, OLD.concept_count, OLD.file_count, OLD.total_bytes,
      OLD.valid, OLD.error_count, OLD.warning_count, OLD.info_count, OLD.quality_score,
      OLD.profile, OLD.field_schema, OLD.metadata, OLD.failure, OLD.created_by, OLD.created_at,
      OLD.processed_at) THEN
    RAISE EXCEPTION 'content of dataset version % is immutable once processed', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'VALIDATED' AND NEW.status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'invalid dataset version status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'PUBLISHED' AND (NEW.published_at, NEW.published_by) IS DISTINCT FROM (OLD.published_at, OLD.published_by) THEN
    RAISE EXCEPTION 'publication record of dataset version % is immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER dataset_versions_guard
  BEFORE UPDATE OR DELETE ON dataset_versions
  FOR EACH ROW EXECUTE FUNCTION okf_guard_dataset_version();
--> statement-breakpoint

-- Child rows (concepts, links, schema columns, files, validation) may only be written while
-- their version is PROCESSING. Deletes are governed by the version guard above (cascades).
CREATE OR REPLACE FUNCTION okf_guard_version_children() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_status version_status;
BEGIN
  SELECT status INTO parent_status FROM dataset_versions WHERE id = NEW.version_id;
  IF parent_status IS DISTINCT FROM 'PROCESSING' THEN
    RAISE EXCEPTION '% rows of dataset version % are immutable (status %)', TG_TABLE_NAME, NEW.version_id, parent_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER concepts_guard BEFORE INSERT OR UPDATE ON concepts
  FOR EACH ROW EXECUTE FUNCTION okf_guard_version_children();
--> statement-breakpoint
CREATE TRIGGER concept_links_guard BEFORE INSERT OR UPDATE ON concept_links
  FOR EACH ROW EXECUTE FUNCTION okf_guard_version_children();
--> statement-breakpoint
CREATE TRIGGER schema_columns_guard BEFORE INSERT OR UPDATE ON schema_columns
  FOR EACH ROW EXECUTE FUNCTION okf_guard_version_children();
--> statement-breakpoint
CREATE TRIGGER dataset_files_guard BEFORE INSERT OR UPDATE ON dataset_files
  FOR EACH ROW EXECUTE FUNCTION okf_guard_version_children();
--> statement-breakpoint
CREATE TRIGGER validation_runs_guard BEFORE INSERT OR UPDATE ON validation_runs
  FOR EACH ROW EXECUTE FUNCTION okf_guard_version_children();
--> statement-breakpoint
CREATE TRIGGER validation_issues_guard BEFORE INSERT OR UPDATE ON validation_issues
  FOR EACH ROW EXECUTE FUNCTION okf_guard_version_children();
