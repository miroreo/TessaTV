ALTER TABLE "app_user" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "oidc_subject" text;--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_oidc_subject" ON "app_user" USING btree ("oidc_subject");