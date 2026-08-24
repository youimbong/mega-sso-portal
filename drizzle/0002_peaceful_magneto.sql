CREATE TABLE "sso_auth_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"portal_session_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"scope" text NOT NULL,
	"nonce" text,
	"code_challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"post_logout_redirect_uris" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"backchannel_logout_uri" text,
	"required_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_clients_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "sso_sessions" (
	"sid" text PRIMARY KEY NOT NULL,
	"portal_session_id" text NOT NULL,
	"client_id" text NOT NULL,
	"user_sub" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_sessions_session_client_uq" UNIQUE("portal_session_id","client_id")
);
--> statement-breakpoint
CREATE TABLE "sso_signing_keys" (
	"kid" text PRIMARY KEY NOT NULL,
	"private_jwk" jsonb NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "employee_code" text;--> statement-breakpoint
CREATE INDEX "sso_sessions_portal_session_idx" ON "sso_sessions" USING btree ("portal_session_id");