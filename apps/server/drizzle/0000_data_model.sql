-- pgvector provides the vector type and HNSW indexes used by asset_embeddings and faces.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."album_asset_source" AS ENUM('manual', 'rule');--> statement-breakpoint
CREATE TYPE "public"."album_member_role" AS ENUM('viewer', 'contributor');--> statement-breakpoint
CREATE TYPE "public"."asset_file_kind" AS ENUM('thumbnail', 'preview', 'playback');--> statement-breakpoint
CREATE TYPE "public"."asset_type" AS ENUM('image', 'video');--> statement-breakpoint
CREATE TYPE "public"."device_platform" AS ENUM('android', 'ios', 'web', 'other');--> statement-breakpoint
CREATE TYPE "public"."processing_state" AS ENUM('pending', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."storage_mode" AS ENUM('original', 'storage_saver');--> statement-breakpoint
CREATE TYPE "public"."tag_source" AS ENUM('clip', 'rule', 'manual');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TABLE "album_assets" (
	"album_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"added_by_id" uuid,
	"source" "album_asset_source" DEFAULT 'manual' NOT NULL,
	"rule_id" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "album_assets_album_id_asset_id_pk" PRIMARY KEY("album_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "album_members" (
	"album_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "album_member_role" DEFAULT 'viewer' NOT NULL,
	"show_in_timeline" boolean DEFAULT false NOT NULL,
	"invited_by_id" uuid,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "album_members_album_id_user_id_pk" PRIMARY KEY("album_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "album_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"album_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"start_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "albums" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"cover_asset_id" uuid,
	"is_live" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_embeddings" (
	"asset_id" uuid PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"embedding" vector(768) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"kind" "asset_file_kind" NOT NULL,
	"file_id" uuid NOT NULL,
	"width" integer,
	"height" integer,
	"mime_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_tags" (
	"asset_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"confidence" real NOT NULL,
	"source" "tag_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_tags_asset_id_tag_id_pk" PRIMARY KEY("asset_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"type" "asset_type" NOT NULL,
	"checksum_sha1" text NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text,
	"device_id" uuid,
	"device_asset_id" text,
	"captured_at" timestamp with time zone,
	"captured_local" timestamp,
	"timezone" text,
	"local_date" date,
	"file_modified_at" timestamp with time zone,
	"latitude" double precision,
	"longitude" double precision,
	"altitude" double precision,
	"city" text,
	"region" text,
	"country" text,
	"country_code" text,
	"camera_make" text,
	"camera_model" text,
	"lens_model" text,
	"exif" jsonb,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"thumbhash" text,
	"is_favorite" boolean DEFAULT false NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"trashed_at" timestamp with time zone,
	"version_of_id" uuid,
	"processing_state" "processing_state" DEFAULT 'pending' NOT NULL,
	"processing_steps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_id_owner_key" UNIQUE("id","owner_id"),
	CONSTRAINT "assets_checksum_sha1_hex" CHECK ("assets"."checksum_sha1" ~ '^[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"platform" "device_platform" NOT NULL,
	"model" text,
	"os_version" text,
	"app_version" text,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_ip" text,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "devices_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "face_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"face_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text DEFAULT 'not_this_person' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "faces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"box_x" real NOT NULL,
	"box_y" real NOT NULL,
	"box_width" real NOT NULL,
	"box_height" real NOT NULL,
	"landmarks" jsonb,
	"detection_score" real,
	"quality" real,
	"embedding" vector(512),
	"model" text,
	"person_id" uuid,
	"assigned_manually" boolean DEFAULT false NOT NULL,
	"ignored" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sha256" text NOT NULL,
	"sha1" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text,
	"ref_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "files_sha256_unique" UNIQUE("sha256"),
	CONSTRAINT "files_ref_count_nonnegative" CHECK ("files"."ref_count" >= 0),
	CONSTRAINT "files_sha256_hex" CHECK ("files"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "files_sha1_hex" CHECK ("files"."sha1" ~ '^[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"email" text,
	"name" text,
	"role" "user_role" DEFAULT 'member' NOT NULL,
	"quota_bytes" bigint,
	"created_by_id" uuid,
	"accepted_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"memory_date" date NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"cover_asset_id" uuid,
	"seen_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_assets" (
	"memory_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "memory_assets_memory_id_asset_id_pk" PRIMARY KEY("memory_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "pairing_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"device_id" uuid,
	CONSTRAINT "pairing_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text,
	"cover_face_id" uuid,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"hide_from_memories" boolean DEFAULT false NOT NULL,
	"face_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "people_id_owner_key" UNIQUE("id","owner_id")
);
--> statement-breakpoint
CREATE TABLE "server_config" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"server_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"home_url" text,
	"remote_url" text,
	"signing_secret" text NOT NULL,
	"library_initialized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_config_singleton" CHECK ("server_config"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "storage_policies" (
	"owner_id" uuid NOT NULL,
	"media_type" "asset_type" NOT NULL,
	"mode" "storage_mode" DEFAULT 'original' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_policies_owner_id_media_type_pk" PRIMARY KEY("owner_id","media_type")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"prompt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'member' NOT NULL,
	"quota_bytes" bigint,
	"disabled_at" timestamp with time zone,
	"invited_by_id" uuid,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "album_assets" ADD CONSTRAINT "album_assets_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_assets" ADD CONSTRAINT "album_assets_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_assets" ADD CONSTRAINT "album_assets_added_by_id_users_id_fk" FOREIGN KEY ("added_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_assets" ADD CONSTRAINT "album_assets_rule_id_album_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."album_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_members" ADD CONSTRAINT "album_members_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_members" ADD CONSTRAINT "album_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_members" ADD CONSTRAINT "album_members_invited_by_id_users_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_rules" ADD CONSTRAINT "album_rules_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_rules" ADD CONSTRAINT "album_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_rules" ADD CONSTRAINT "album_rules_person_owner_fk" FOREIGN KEY ("person_id","user_id") REFERENCES "public"."people"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "albums" ADD CONSTRAINT "albums_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "albums" ADD CONSTRAINT "albums_cover_asset_id_assets_id_fk" FOREIGN KEY ("cover_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_embeddings" ADD CONSTRAINT "asset_embeddings_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_files" ADD CONSTRAINT "asset_files_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_files" ADD CONSTRAINT "asset_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_tags" ADD CONSTRAINT "asset_tags_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_tags" ADD CONSTRAINT "asset_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_feedback" ADD CONSTRAINT "face_feedback_face_id_faces_id_fk" FOREIGN KEY ("face_id") REFERENCES "public"."faces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_feedback" ADD CONSTRAINT "face_feedback_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_feedback" ADD CONSTRAINT "face_feedback_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faces" ADD CONSTRAINT "faces_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faces" ADD CONSTRAINT "faces_asset_owner_fk" FOREIGN KEY ("asset_id","owner_id") REFERENCES "public"."assets"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_accepted_by_id_users_id_fk" FOREIGN KEY ("accepted_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_cover_asset_id_assets_id_fk" FOREIGN KEY ("cover_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_assets" ADD CONSTRAINT "memory_assets_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_assets" ADD CONSTRAINT "memory_assets_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_cover_face_id_faces_id_fk" FOREIGN KEY ("cover_face_id") REFERENCES "public"."faces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_policies" ADD CONSTRAINT "storage_policies_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_invited_by_id_users_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "album_assets_asset_idx" ON "album_assets" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "album_members_user_idx" ON "album_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "album_rules_album_person_key" ON "album_rules" USING btree ("album_id","person_id");--> statement-breakpoint
CREATE INDEX "album_rules_person_idx" ON "album_rules" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "albums_owner_idx" ON "albums" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "asset_embeddings_embedding_idx" ON "asset_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "asset_files_asset_kind_key" ON "asset_files" USING btree ("asset_id","kind");--> statement-breakpoint
CREATE INDEX "asset_files_file_id_idx" ON "asset_files" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "asset_tags_tag_idx" ON "asset_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_owner_checksum_key" ON "assets" USING btree ("owner_id","checksum_sha1");--> statement-breakpoint
CREATE INDEX "assets_owner_captured_idx" ON "assets" USING btree ("owner_id","captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "assets_owner_local_date_idx" ON "assets" USING btree ("owner_id","local_date");--> statement-breakpoint
CREATE INDEX "assets_file_id_idx" ON "assets" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "assets_version_of_idx" ON "assets" USING btree ("version_of_id");--> statement-breakpoint
CREATE INDEX "assets_trashed_idx" ON "assets" USING btree ("trashed_at") WHERE "assets"."trashed_at" is not null;--> statement-breakpoint
CREATE INDEX "devices_user_id_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "face_feedback_face_person_key" ON "face_feedback" USING btree ("face_id","person_id");--> statement-breakpoint
CREATE INDEX "faces_asset_idx" ON "faces" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "faces_owner_person_idx" ON "faces" USING btree ("owner_id","person_id");--> statement-breakpoint
CREATE INDEX "faces_embedding_idx" ON "faces" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "files_sha1_idx" ON "files" USING btree ("sha1");--> statement-breakpoint
CREATE INDEX "files_unreferenced_idx" ON "files" USING btree ("created_at") WHERE "files"."ref_count" = 0;--> statement-breakpoint
CREATE INDEX "invites_created_at_idx" ON "invites" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "memories_owner_date_idx" ON "memories" USING btree ("owner_id","memory_date");--> statement-breakpoint
CREATE INDEX "memory_assets_asset_idx" ON "memory_assets" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "pairing_codes_user_id_idx" ON "pairing_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "people_owner_idx" ON "people" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree (lower("email"));