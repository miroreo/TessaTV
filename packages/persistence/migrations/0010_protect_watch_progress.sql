ALTER TABLE "watch_progress" DROP CONSTRAINT "watch_progress_user_id_app_user_id_fk";
--> statement-breakpoint
ALTER TABLE "watch_progress" DROP CONSTRAINT "watch_progress_unit_id_unit_id_fk";
--> statement-breakpoint
ALTER TABLE "watch_progress" ADD CONSTRAINT "watch_progress_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_progress" ADD CONSTRAINT "watch_progress_unit_id_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."unit"("id") ON DELETE restrict ON UPDATE no action;