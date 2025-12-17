CREATE TABLE "user_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"fingerprint_sha256" varchar(64) NOT NULL,
	"public_key" text NOT NULL,
	"key_type" varchar(32) DEFAULT 'ssh-ed25519' NOT NULL,
	"label" varchar(128),
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_keys_fingerprint_sha256_unique" UNIQUE("fingerprint_sha256")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "avatar_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"avatar_id" uuid NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "avatars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"sprite_json" jsonb,
	"generation_status" varchar(32) DEFAULT 'pending' NOT NULL,
	"generation_error" text,
	"model_used" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "avatars_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "chunk_deltas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chunk_x" integer NOT NULL,
	"chunk_y" integer NOT NULL,
	"tile_x" integer NOT NULL,
	"tile_y" integer NOT NULL,
	"tile_id" varchar(64) NOT NULL,
	"placed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tile_definitions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"name" varchar(128) NOT NULL,
	"pixels" jsonb NOT NULL,
	"walkable" integer DEFAULT 1 NOT NULL,
	"animated" integer DEFAULT 0 NOT NULL,
	"animation_frames" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tilemap_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chunk_x" integer NOT NULL,
	"chunk_y" integer NOT NULL,
	"tiles" jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone,
	"modified_by" uuid
);
--> statement-breakpoint
CREATE TABLE "world" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"seed" bigint NOT NULL,
	"name" varchar(128) DEFAULT 'Maldoror' NOT NULL,
	"tick_rate_hz" integer DEFAULT 15 NOT NULL,
	"chunk_size_tiles" integer DEFAULT 16 NOT NULL,
	"tile_size_pixels" integer DEFAULT 16 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"user_id" uuid,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"x" integer DEFAULT 0 NOT NULL,
	"y" integer DEFAULT 0 NOT NULL,
	"direction" varchar(8) DEFAULT 'down' NOT NULL,
	"animation_frame" integer DEFAULT 0 NOT NULL,
	"is_online" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_input_at" timestamp with time zone DEFAULT now() NOT NULL,
	"session_id" uuid,
	"connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_state_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"viewport_x" integer DEFAULT 0 NOT NULL,
	"viewport_y" integer DEFAULT 0 NOT NULL,
	"viewport_width" integer DEFAULT 80 NOT NULL,
	"viewport_height" integer DEFAULT 24 NOT NULL,
	"connection_type" varchar(32) DEFAULT 'ssh' NOT NULL,
	"client_info" jsonb,
	"ip_address" varchar(45),
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_keys" ADD CONSTRAINT "user_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "avatar_jobs" ADD CONSTRAINT "avatar_jobs_avatar_id_avatars_id_fk" FOREIGN KEY ("avatar_id") REFERENCES "public"."avatars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "avatars" ADD CONSTRAINT "avatars_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunk_deltas" ADD CONSTRAINT "chunk_deltas_tile_id_tile_definitions_id_fk" FOREIGN KEY ("tile_id") REFERENCES "public"."tile_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunk_deltas" ADD CONSTRAINT "chunk_deltas_placed_by_users_id_fk" FOREIGN KEY ("placed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tilemap_chunks" ADD CONSTRAINT "tilemap_chunks_modified_by_users_id_fk" FOREIGN KEY ("modified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_events" ADD CONSTRAINT "game_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_state" ADD CONSTRAINT "player_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_keys_user_id" ON "user_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_keys_fingerprint" ON "user_keys" USING btree ("fingerprint_sha256");--> statement-breakpoint
CREATE INDEX "idx_users_username" ON "users" USING btree ("username");--> statement-breakpoint
CREATE INDEX "idx_avatar_jobs_status" ON "avatar_jobs" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_avatar_jobs_avatar_id" ON "avatar_jobs" USING btree ("avatar_id");--> statement-breakpoint
CREATE INDEX "idx_avatars_user_id" ON "avatars" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_avatars_generation_status" ON "avatars" USING btree ("generation_status");--> statement-breakpoint
CREATE INDEX "idx_chunk_deltas_chunk" ON "chunk_deltas" USING btree ("chunk_x","chunk_y");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_chunk_deltas_unique" ON "chunk_deltas" USING btree ("chunk_x","chunk_y","tile_x","tile_y");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tilemap_chunks_coords" ON "tilemap_chunks" USING btree ("chunk_x","chunk_y");--> statement-breakpoint
CREATE INDEX "idx_game_events_type" ON "game_events" USING btree ("event_type","created_at");--> statement-breakpoint
CREATE INDEX "idx_game_events_user" ON "game_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_player_state_user_id" ON "player_state" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_player_state_online" ON "player_state" USING btree ("is_online");--> statement-breakpoint
CREATE INDEX "idx_player_state_position" ON "player_state" USING btree ("x","y");--> statement-breakpoint
CREATE INDEX "idx_sessions_user_id" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_heartbeat" ON "sessions" USING btree ("last_heartbeat_at");