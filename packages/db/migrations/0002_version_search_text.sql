ALTER TABLE "dataset_versions" ADD COLUMN "search_text" text;--> statement-breakpoint
-- search_text is version content: include it in the immutability guard.
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
      NEW.profile, NEW.field_schema, NEW.metadata, NEW.search_text, NEW.failure, NEW.created_by,
      NEW.created_at, NEW.processed_at)
     IS DISTINCT FROM
     (OLD.dataset_id, OLD.organization_id, OLD.number, OLD.source_type, OLD.source_url,
      OLD.original_filename, OLD.archive_key, OLD.archive_size, OLD.archive_sha256, OLD.format,
      OLD.scan_status, OLD.okf_version, OLD.concept_count, OLD.file_count, OLD.total_bytes,
      OLD.valid, OLD.error_count, OLD.warning_count, OLD.info_count, OLD.quality_score,
      OLD.profile, OLD.field_schema, OLD.metadata, OLD.search_text, OLD.failure, OLD.created_by,
      OLD.created_at, OLD.processed_at) THEN
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
