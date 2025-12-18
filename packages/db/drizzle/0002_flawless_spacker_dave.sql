CREATE TABLE "building_tiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"building_id" uuid NOT NULL,
	"tile_x" integer NOT NULL,
	"tile_y" integer NOT NULL,
	"resolution" integer NOT NULL,
	"file_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_building_tiles" UNIQUE("building_id","tile_x","tile_y","resolution")
);
--> statement-breakpoint
CREATE TABLE "sprite_frames" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"direction" varchar(8) NOT NULL,
	"frame_num" integer NOT NULL,
	"resolution" integer NOT NULL,
	"file_path" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_sprite_frames" UNIQUE("user_id","direction","frame_num","resolution")
);
--> statement-breakpoint
ALTER TABLE "building_tiles" ADD CONSTRAINT "building_tiles_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprite_frames" ADD CONSTRAINT "sprite_frames_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_building_tiles_building" ON "building_tiles" USING btree ("building_id");--> statement-breakpoint
CREATE INDEX "idx_sprite_frames_user" ON "sprite_frames" USING btree ("user_id");