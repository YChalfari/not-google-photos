CREATE TYPE "public"."asset_intake" AS ENUM('library', 'review');--> statement-breakpoint
CREATE TABLE "rejected_checksums" (
	"owner_id" uuid NOT NULL,
	"sha1" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rejected_checksums_owner_id_sha1_pk" PRIMARY KEY("owner_id","sha1"),
	CONSTRAINT "rejected_checksums_sha1_hex" CHECK ("rejected_checksums"."sha1" ~ '^[0-9a-f]{40}$')
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "intake" "asset_intake" DEFAULT 'library' NOT NULL;--> statement-breakpoint
ALTER TABLE "rejected_checksums" ADD CONSTRAINT "rejected_checksums_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_owner_review_idx" ON "assets" USING btree ("owner_id","captured_at" DESC NULLS LAST) WHERE "assets"."intake" = 'review';