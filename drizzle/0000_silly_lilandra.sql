CREATE TYPE "public"."launch_mode" AS ENUM('link', 'iframe');--> statement-breakpoint
CREATE TABLE "app_roles" (
	"app_id" uuid NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "app_roles_app_id_role_pk" PRIMARY KEY("app_id","role")
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"target_url" text NOT NULL,
	"mode" "launch_mode" DEFAULT 'link' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apps_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_sub" text NOT NULL,
	"sso_sid" text,
	"email" text,
	"name" text,
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"id_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_roles" ADD CONSTRAINT "app_roles_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_sso_sid_idx" ON "sessions" USING btree ("sso_sid");--> statement-breakpoint
CREATE INDEX "sessions_user_sub_idx" ON "sessions" USING btree ("user_sub");