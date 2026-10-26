-- Constraints and triggers Drizzle can't express. Keep apps/server/src/db/schema.ts comments in sync.

-- A face can only belong to a person in the same library. Deleting the person unassigns the face
-- (only person_id is cleared; owner_id stays).
ALTER TABLE "faces"
  ADD CONSTRAINT "faces_person_owner_fk"
  FOREIGN KEY ("person_id", "owner_id") REFERENCES "people" ("id", "owner_id")
  ON DELETE SET NULL ("person_id");
--> statement-breakpoint

-- An edited copy points at an original in the same library.
ALTER TABLE "assets"
  ADD CONSTRAINT "assets_version_of_owner_fk"
  FOREIGN KEY ("version_of_id", "owner_id") REFERENCES "assets" ("id", "owner_id")
  ON DELETE SET NULL ("version_of_id");
--> statement-breakpoint

-- files.ref_count = number of assets + asset_files rows that point at the file. Blobs whose count
-- drops to zero are removed by the maintenance job after a grace period.
CREATE OR REPLACE FUNCTION "ngp_track_file_refs"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE "files" SET "ref_count" = "ref_count" + 1 WHERE "id" = NEW."file_id";
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE "files" SET "ref_count" = "ref_count" - 1 WHERE "id" = OLD."file_id";
  ELSIF NEW."file_id" IS DISTINCT FROM OLD."file_id" THEN
    UPDATE "files" SET "ref_count" = "ref_count" - 1 WHERE "id" = OLD."file_id";
    UPDATE "files" SET "ref_count" = "ref_count" + 1 WHERE "id" = NEW."file_id";
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "assets_track_file_refs"
  AFTER INSERT OR DELETE OR UPDATE OF "file_id" ON "assets"
  FOR EACH ROW EXECUTE FUNCTION "ngp_track_file_refs"();
--> statement-breakpoint

CREATE TRIGGER "asset_files_track_file_refs"
  AFTER INSERT OR DELETE OR UPDATE OF "file_id" ON "asset_files"
  FOR EACH ROW EXECUTE FUNCTION "ngp_track_file_refs"();
